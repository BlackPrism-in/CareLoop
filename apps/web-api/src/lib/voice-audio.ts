'use client';

/** Downsamples mic audio to 16 kHz mono PCM16 in an AudioWorklet and emits ~100 ms base64 chunks. */
const WORKLET = `
class Pcm16Capture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = []; this.ratio = sampleRate / 16000; this.acc = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += 1;
      if (this.acc >= this.ratio) { this.acc -= this.ratio; const s = Math.max(-1, Math.min(1, ch[i])); this.buf.push(s < 0 ? s * 0x8000 : s * 0x7fff); }
    }
    if (this.buf.length >= 1600) { this.port.postMessage(Int16Array.from(this.buf.splice(0, 1600)).buffer, []); }
    return true;
  }
}
registerProcessor('pcm16-capture', Pcm16Capture);
`;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class MicCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;

  async start(onChunk: (b64: string) => void): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    this.ctx = new AudioContext();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const node = new AudioWorkletNode(this.ctx, 'pcm16-capture');
    node.port.onmessage = (e) => onChunk(toBase64(e.data as ArrayBuffer));
    this.ctx.createMediaStreamSource(this.stream).connect(node);
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.ctx = null;
    this.stream = null;
  }
}

/** Plays model audio (PCM16, rate from the mime type) gaplessly; interruption flushes the queue. */
export class PcmPlayer {
  private ctx: AudioContext | null = null;
  private next = 0;
  private sources: AudioBufferSourceNode[] = [];

  play(b64: string, mimeType: string): void {
    const rate = Number(/rate=(\d+)/.exec(mimeType)?.[1] ?? 24000);
    this.ctx ??= new AudioContext();
    const bin = atob(b64);
    const pcm = new Int16Array(bin.length / 2);
    for (let i = 0; i < pcm.length; i++)
      pcm[i] = ((bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8)) << 16) >> 16;
    const buf = this.ctx.createBuffer(1, pcm.length, rate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) data[i] = pcm[i]! / 0x8000;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    const at = Math.max(this.ctx.currentTime, this.next);
    src.start(at);
    this.next = at + buf.duration;
    this.sources.push(src);
    src.onended = () => (this.sources = this.sources.filter((s) => s !== src));
  }

  interrupt(): void {
    this.sources.forEach((s) => s.stop());
    this.sources = [];
    this.next = 0;
  }

  close(): void {
    this.interrupt();
    void this.ctx?.close();
    this.ctx = null;
  }
}
