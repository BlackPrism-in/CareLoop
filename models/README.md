# Local intake model API

This Python API runs only on `127.0.0.1` and is meant for local experiments with synthetic notes. It does not save requests or write to CareLoop case data. The `IntakeModel` protocol in `intake_app.py` is the provider boundary; a LangChain adapter can implement that interface later without changing the API or validator.

## Start

Install the Python dependencies once, then set `GEMINI_API_KEY` and `FLASH_LITE_MODEL_ID` in `models/.env`. From the repository root run:

```powershell
python -m pip install -r models/requirements.txt
corepack pnpm dev:models-api
```

The server listens at `http://127.0.0.1:3001`. Set `MODEL_API_PORT` to use another port.

## Check health

```powershell
Invoke-RestMethod http://127.0.0.1:3001/health
```

## Upload a document and preview an intake

Send one PDF, DOCX, or UTF-8 TXT file as a multipart `file` field. Optional `sourceAuthority` and `languageHint` fields are also accepted. For example, with `curl.exe` in PowerShell:

```powershell
curl.exe -X POST http://127.0.0.1:3001/v1/intake/preview `
  -F "file=@C:\path\to\synthetic-note.pdf" `
  -F "sourceAuthority=synthetic test note" `
  -F "languageHint=English"
```

The response contains the extracted text in `document.extractedText` and a validated `proposal` with fields, computed `missing` fields, warnings, a tenant-scoped duplicate fingerprint when required inputs are present, and metadata. Source-span offsets refer to this extracted text. Files are limited to 8 MB, PDFs to 40 pages, and extracted text to 20,000 characters. Scanned PDFs without selectable text need OCR, which this API does not provide.

The JSON `sourceText` request is still available for notes whose text has already been extracted. Model failures and unreadable documents return non-2xx responses with an error code and message.

Run the rules and Gemini evaluator from the repository root with `corepack pnpm eval:models`. The full seed set has 22 cases. To rerun selected cases, set `EVAL_CASE_IDS` to comma-separated seed IDs, for example `$env:EVAL_CASE_IDS='clean-001,hinglish-001'; corepack pnpm eval:models`.

Because note text is sent to Gemini, use synthetic notes only in this local testing API. Do not expose this server to a network or send real patient information.

## Conversation proposal preview

The Conversation proposal core uses LangChain structured output. It is a local transcript-to-proposal preview, not the Gemini Live audio gateway yet. Start it separately on `127.0.0.1:3002`:

```powershell
corepack pnpm dev:conversation-api
```

`POST /v1/conversation/preview` accepts a synthetic `caseId`, `approvalRevision`, patient `transcript`, `language` (`en-IN`, `hi-IN`, `bn-BD`, or `ne`), and preview context (`availableSlots`, `identityVerified`, and `confirmedSlotId`). These are the language tags supported by the configured Gemini Live model: English (India), Hindi (India), Bengali (Bangladesh), and Nepali. It returns the shared `AgentProposal` shape, including captured preferences and barriers. Booking proposals are downgraded to `NO_ACTION` unless identity is verified, the slot is in the supplied list, and the same slot is confirmed. This preview does not execute domain commands or persist state. Never expose it outside localhost; the future voice gateway must source case and slot context from authenticated server state.

Example body for a synthetic scheduling turn:

```json
{
  "caseId": "demo-case-01",
  "approvalRevision": 1,
  "transcript": "I cannot come during work hours. Do you have an evening time?",
  "language": "en-IN",
  "identityVerified": true,
  "availableSlots": [
    { "slotId": "demo-evening-01", "startsAt": "2026-11-24T18:30:00+05:30", "endsAt": "2026-11-24T18:45:00+05:30" }
  ]
}
```

The response is only a proposal. Confirming a slot is a separate session event; the preview body must include `confirmedSlotId` matching an offered `slotId` before the policy gate permits `REQUEST_BOOKING`.

## Upload a voice recording for transcript and translation

`POST /v1/conversation/transcribe` accepts one audio file in the multipart `file` field. Supported formats are WAV, MP3, M4A, AAC, OGG, FLAC, AIFF, and WEBM; the upload limit is 15 MB. Add `languageHint` if you know the spoken language (`en-IN`, `hi-IN`, `bn-BD`, `ne`). `translationLanguage` is optional and defaults to English (`en-IN`). The response includes `detectedLanguage`, `nativeTranscript`, and `translation`.

```powershell
$raw = curl.exe -sS -X POST http://127.0.0.1:3002/v1/conversation/transcribe `
  -F "file=@C:\path\to\voice-recording.mp3" `
  -F "languageHint=bn-BD" `
  -F "translationLanguage=en-IN"
$result = $raw | ConvertFrom-Json
$result | Select-Object detectedLanguage, nativeTranscript, translationLanguage, translation
```

The API processes the upload in memory and does not save the audio or transcript. It sends the recording to Gemini for transcription and translation; use synthetic or consented recordings only. This is file transcription, not a live microphone/WebSocket conversation.

Successful responses have this shape:

```json
{
  "filename": "voice-recording.mp3",
  "audioBytes": 123456,
  "detectedLanguage": "bn-BD",
  "nativeTranscript": "transcript in the spoken language and script",
  "translation": "English translation",
  "translationLanguage": "en-IN",
  "meta": { "modelId": "gemini-3.8-flash", "latencyMs": 1200 }
}
```
