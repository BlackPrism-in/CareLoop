"""Local, synthetic-only API for testing Conversation proposals (not audio sessions)."""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
from pathlib import PurePath

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env.local")
load_dotenv(Path(__file__).with_name(".env"))

from conversation_agent import GeminiAudioTranscriber, LangChainConversationAgent, VoiceLanguage

app = FastAPI(title="CareLoop Conversation API")
MAX_AUDIO_BYTES = 15 * 1024 * 1024
AUDIO_TYPES = {
    ".aac": "audio/aac",
    ".aiff": "audio/aiff",
    ".flac": "audio/flac",
    ".m4a": "audio/m4a",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".webm": "audio/webm",
}


class StrictRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class PreviewRequest(StrictRequest):
    caseId: str = Field(min_length=1)
    approvalRevision: int = Field(ge=1)
    transcript: str = Field(min_length=1, max_length=8_000)
    language: VoiceLanguage = "en-IN"
    # Local preview only. Production WSS derives these from server session/domain state.
    identityVerified: bool = False
    confirmedSlotId: str | None = None
    availableSlots: list[dict] = Field(default_factory=list, max_length=20)
    allowedSourceRefs: list[str] = Field(default_factory=list, max_length=20)


@app.get("/health")
async def health():
    return {
        "ok": True,
        "service": "careloop-conversation-preview",
        "configured": bool(os.getenv("GEMINI_API_KEY")),
        "mode": "proposal-preview-and-audio-transcription",
        "languages": ["en-IN", "hi-IN", "bn-BD", "ne"],
    }


@app.post("/v1/conversation/preview")
async def preview(body: PreviewRequest):
    if not os.getenv("GEMINI_API_KEY"):
        return JSONResponse(status_code=503, content={"error": {"code": "MODEL_NOT_CONFIGURED", "message": "Set GEMINI_API_KEY in models/.env"}})
    try:
        agent = LangChainConversationAgent()
        proposal = await asyncio.wait_for(agent.propose(body.model_dump()), timeout=30)
        result = {"proposal": proposal.model_dump(by_alias=True)}
        if proposal.intent == "CREATE_HANDOFF" and proposal.arguments.reasonCode == "MEDICAL_QUESTION":
            result["directive"] = "USE_SITE_APPROVED_MEDICAL_RESPONSE_AND_CREATE_STAFF_TASK"
        elif proposal.intent == "CREATE_HANDOFF" and proposal.arguments.reasonCode == "HUMAN_REQUESTED":
            result["directive"] = "CONNECT_OR_CREATE_HUMAN_HANDOFF"
        return result
    except (ValidationError, ValueError) as exc:
        return JSONResponse(status_code=422, content={"error": {"code": "INVALID_PROPOSAL", "message": str(exc)[:400]}})
    except TimeoutError:
        return JSONResponse(status_code=504, content={"error": {"code": "MODEL_TIMEOUT", "message": "Conversation planner timed out."}})
    except Exception as exc:
        return JSONResponse(status_code=502, content={"error": {"code": "MODEL_CALL_FAILED", "message": str(exc)[:400]}})


@app.post("/v1/conversation/transcribe")
async def transcribe(request: Request):
    """Upload one audio recording; files/transcripts are not persisted by this API."""
    if not os.getenv("GEMINI_API_KEY"):
        return JSONResponse(status_code=503, content={"error": {"code": "MODEL_NOT_CONFIGURED", "message": "Set GEMINI_API_KEY in models/.env"}})
    declared = request.headers.get("content-length")
    if declared:
        try:
            if int(declared) > MAX_AUDIO_BYTES + 32 * 1024:
                return JSONResponse(status_code=413, content={"error": {"code": "AUDIO_TOO_LARGE", "message": "Audio upload limit is 15 MB."}})
        except ValueError:
            return JSONResponse(status_code=400, content={"error": {"code": "INVALID_REQUEST", "message": "Invalid Content-Length."}})
    try:
        form = await request.form()
    except Exception:
        return JSONResponse(status_code=400, content={"error": {"code": "INVALID_MULTIPART", "message": "Send multipart form data with one audio file."}})
    items = form.multi_items()
    if any(key not in ("file", "translationLanguage", "languageHint") for key, _ in items):
        return JSONResponse(status_code=400, content={"error": {"code": "INVALID_REQUEST", "message": "Only file, translationLanguage, and languageHint fields are accepted."}})
    files = [value for key, value in items if key == "file" and hasattr(value, "filename")]
    if len(files) != 1 or sum(1 for key, _ in items if key == "file") != 1:
        return JSONResponse(status_code=400, content={"error": {"code": "FILE_REQUIRED", "message": "Upload exactly one recording in the `file` field."}})
    values = {key: value for key, value in items if key != "file"}
    if len(values) != len(items) - 1:
        return JSONResponse(status_code=400, content={"error": {"code": "DUPLICATE_FIELD", "message": "Each optional field may be sent once."}})
    target = values.get("translationLanguage", "en-IN")
    hint = values.get("languageHint")
    if target not in ("en-IN", "hi-IN", "bn-BD", "ne") or (hint is not None and hint not in ("en-IN", "hi-IN", "bn-BD", "ne")):
        return JSONResponse(status_code=422, content={"error": {"code": "UNSUPPORTED_LANGUAGE", "message": "Use en-IN, hi-IN, bn-BD, or ne."}})
    upload = files[0]
    filename = PurePath((upload.filename or "").replace("\\", "/")).name
    extension = Path(filename).suffix.lower()
    mime_type = AUDIO_TYPES.get(extension)
    if not mime_type:
        return JSONResponse(status_code=415, content={"error": {"code": "UNSUPPORTED_AUDIO_TYPE", "message": "Supported formats: WAV, MP3, M4A, AAC, OGG, FLAC, AIFF, and WEBM."}})
    audio = await upload.read(MAX_AUDIO_BYTES + 1)
    if len(audio) > MAX_AUDIO_BYTES:
        return JSONResponse(status_code=413, content={"error": {"code": "AUDIO_TOO_LARGE", "message": "Audio upload limit is 15 MB."}})
    if not audio:
        return JSONResponse(status_code=422, content={"error": {"code": "EMPTY_AUDIO", "message": "The uploaded recording is empty."}})
    try:
        transcriber = GeminiAudioTranscriber()
        result = await asyncio.wait_for(transcriber.transcribe(audio, mime_type, target, hint), timeout=120)
        return JSONResponse(content={
            "filename": filename,
            "audioBytes": len(audio),
            "detectedLanguage": result.detectedLanguage,
            "nativeTranscript": result.nativeTranscript,
            "translation": result.translation,
            "translationLanguage": result.translationLanguage,
            "meta": {"modelId": result.modelId, "latencyMs": result.latencyMs},
        }, headers={"cache-control": "no-store", "x-content-type-options": "nosniff"})
    except TimeoutError:
        return JSONResponse(status_code=504, content={"error": {"code": "TRANSCRIPTION_TIMEOUT", "message": "Audio transcription timed out."}})
    except Exception as exc:
        return JSONResponse(status_code=502, content={"error": {"code": "TRANSCRIPTION_FAILED", "message": str(exc)[:400]}})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("CONVERSATION_API_PORT", "3002")))
