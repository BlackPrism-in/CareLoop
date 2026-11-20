import { Modality, type GoogleGenAI, type Session } from '@google/genai';

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LiveEvents {
  onAudio(base64Pcm: string, mimeType: string): void;
  onInputTranscript(text: string): void;
  onOutputTranscript(text: string): void;
  onToolCalls(calls: ToolCall[]): void;
  onInterrupted(): void;
  onTurnComplete(): void;
  onClose(reason: string): void;
}

/** One live model conversation. The gateway is the only party that talks to it. */
export interface LiveSession {
  sendAudio(base64Pcm16k: string): void;
  /** A typed patient turn (text alternative to voice), or a bracketed staff/system note. */
  sendText(text: string): void;
  sendToolResponses(
    responses: { id: string; name: string; response: Record<string, unknown> }[],
  ): void;
  close(): void;
}

export interface FunctionDecl {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LiveConnector {
  connect(
    opts: { model: string; system: string; tools: FunctionDecl[] },
    events: LiveEvents,
  ): Promise<LiveSession>;
}

/** Gemini Live via the Gen AI SDK. Audio in: 16 kHz PCM16 mono. Audio out: PCM16 at the rate in mimeType. */
export class GenAiLiveConnector implements LiveConnector {
  constructor(private readonly client: GoogleGenAI) {}

  async connect(
    opts: { model: string; system: string; tools: FunctionDecl[] },
    ev: LiveEvents,
  ): Promise<LiveSession> {
    let session: Session | undefined;
    session = await this.client.live.connect({
      model: opts.model,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: opts.system,
        tools: [
          {
            functionDeclarations: opts.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parametersJsonSchema: t.parameters,
            })),
          },
        ],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        temperature: 0.3,
      },
      callbacks: {
        onmessage: (m) => {
          const sc = m.serverContent;
          if (sc?.interrupted) ev.onInterrupted();
          for (const part of sc?.modelTurn?.parts ?? []) {
            if (part.inlineData?.data && part.inlineData.mimeType?.startsWith('audio/'))
              ev.onAudio(part.inlineData.data, part.inlineData.mimeType);
          }
          if (sc?.inputTranscription?.text) ev.onInputTranscript(sc.inputTranscription.text);
          if (sc?.outputTranscription?.text) ev.onOutputTranscript(sc.outputTranscription.text);
          if (sc?.turnComplete) ev.onTurnComplete();
          const calls = m.toolCall?.functionCalls ?? [];
          if (calls.length)
            ev.onToolCalls(
              calls.map((c) => ({
                id: c.id ?? '',
                name: c.name ?? '',
                args: (c.args ?? {}) as Record<string, unknown>,
              })),
            );
          if (m.goAway) ev.onClose('MODEL_GOAWAY');
        },
        onerror: () => ev.onClose('MODEL_ERROR'),
        onclose: () => ev.onClose('MODEL_CLOSED'),
      },
    });
    const s = session;
    return {
      sendAudio: (b64) =>
        s.sendRealtimeInput({ audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } }),
      sendText: (text) =>
        s.sendClientContent({ turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true }),
      sendToolResponses: (rs) =>
        s.sendToolResponse({
          functionResponses: rs.map((r) => ({ id: r.id, name: r.name, response: r.response })),
        }),
      close: () => s.close(),
    };
  }
}
