'use client';
import { useEffect, useRef, useState } from 'react';
import { api, describeError } from '@/lib/api';
import { MicCapture, PcmPlayer } from '@/lib/voice-audio';
import { Button, Card, cx, inputClass, Notice, SimulationBadge } from './ui';

interface Session {
  ticket: string;
  wsUrl: string;
  interactionId: string;
  simulation: boolean;
}

type Line = { who: 'patient' | 'agent' | 'event'; text: string };

/**
 * Supervised browser call (MVP spec §11). The staff member plays or listens to
 * the patient; the voice agent runs on the server. A text box is the
 * accessible alternative to speaking.
 */
export function VoicePanel({ caseId, onEnded }: { caseId: string; onEnded: () => void }) {
  const [state, setState] = useState<'idle' | 'connecting' | 'live' | 'ended'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [simulation, setSimulation] = useState(false);
  const [identity, setIdentity] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [cap, setCap] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [text, setText] = useState('');
  const [summary, setSummary] = useState<string | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const mic = useRef<MicCapture | null>(null);
  const player = useRef<PcmPlayer | null>(null);
  const logRef = useRef<HTMLOListElement>(null);

  const add = (l: Line) =>
    setLines((ls) => {
      const last = ls.at(-1);
      // Streaming transcripts arrive in fragments: append to the speaker's current line.
      if (last && last.who === l.who && l.who !== 'event')
        return [...ls.slice(0, -1), { who: l.who, text: `${last.text}${l.text}` }];
      return [...ls, l];
    });

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [lines]);

  useEffect(() => {
    if (state !== 'live') return;
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [state]);

  useEffect(() => () => cleanup(), []);

  function cleanup() {
    mic.current?.stop();
    player.current?.close();
    ws.current?.close();
    mic.current = null;
    setMicOn(false);
  }

  async function startCall() {
    setError(null);
    setLines([]);
    setState('connecting');
    try {
      const s = await api<Session>('/v1/voice/sessions', { method: 'POST', body: { caseId } });
      setSimulation(s.simulation);
      player.current = new PcmPlayer();
      const sock = new WebSocket(s.wsUrl);
      ws.current = sock;
      sock.onopen = () => sock.send(JSON.stringify({ type: 'auth', ticket: s.ticket }));
      sock.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.type === 'ready') {
          setCap(m.capSeconds);
          setElapsed(0);
          setState('live');
        } else if (m.type === 'audio') player.current?.play(m.data, m.mimeType);
        else if (m.type === 'interrupted') player.current?.interrupt();
        else if (m.type === 'transcript') add({ who: m.who, text: m.text });
        else if (m.type === 'event') add({ who: 'event', text: m.detail });
        else if (m.type === 'error') {
          setError(m.message);
          setState('ended');
        } else if (m.type === 'ended') {
          setSummary(
            `Call ended (${m.reason.toLowerCase().replaceAll('_', ' ')}). Outcome: ${m.disposition.toLowerCase().replaceAll('_', ' ')} · ${m.audioSeconds}s billed.`,
          );
          setState('ended');
          cleanup();
          onEnded();
        }
      };
      sock.onclose = () => setState((st) => (st === 'live' || st === 'connecting' ? 'ended' : st));
    } catch (e) {
      setError(describeError(e));
      setState('idle');
    }
  }

  async function toggleMic() {
    if (micOn) {
      mic.current?.stop();
      mic.current = null;
      setMicOn(false);
      return;
    }
    try {
      mic.current = new MicCapture();
      await mic.current.start(
        (b64) =>
          ws.current?.readyState === WebSocket.OPEN &&
          ws.current.send(JSON.stringify({ type: 'audio', data: b64 })),
      );
      setMicOn(true);
    } catch {
      setError('Microphone permission was not granted. You can type instead.');
    }
  }

  const send = (m: object) =>
    ws.current?.readyState === WebSocket.OPEN && ws.current.send(JSON.stringify(m));

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          Voice call {simulation && <SimulationBadge />}
        </span>
      }
      actions={
        state === 'live' ? (
          <span className="text-xs tabular-nums text-[var(--muted)]">
            {elapsed}s / {cap}s
          </span>
        ) : undefined
      }
    >
      <div className="space-y-3 text-sm">
        {state === 'idle' && (
          <>
            <p>
              The AI assistant introduces itself, offers a human, waits for identity confirmation,
              then helps with timing. It can only offer times from the calendar and can&apos;t give
              medical advice.
            </p>
            <Button variant="primary" onClick={startCall}>
              Open call
            </Button>
          </>
        )}
        {state === 'connecting' && <p className="text-[var(--muted)]">Connecting…</p>}
        {(state === 'live' || lines.length > 0) && (
          <ol
            ref={logRef}
            aria-live="polite"
            className="max-h-72 space-y-2 overflow-y-auto rounded-md border border-[var(--line)] bg-[var(--bg)] p-3"
          >
            {lines.map((l, i) => (
              <li key={i} className={cx(l.who === 'event' && 'text-xs text-[var(--muted)]')}>
                {l.who === 'event' ? (
                  `• ${l.text}`
                ) : (
                  <>
                    <span className="font-medium">
                      {l.who === 'agent' ? 'Assistant' : 'Patient'}:
                    </span>{' '}
                    {l.text}
                  </>
                )}
              </li>
            ))}
            {lines.length === 0 && (
              <li className="text-[var(--muted)]">Waiting for the assistant…</li>
            )}
          </ol>
        )}
        {state === 'live' && (
          <>
            <div className="flex flex-wrap gap-2">
              <Button onClick={toggleMic} aria-pressed={micOn}>
                {micOn ? '■ Mute mic' : '● Use mic'}
              </Button>
              <Button
                variant={identity ? 'secondary' : 'primary'}
                disabled={identity}
                onClick={() => {
                  setIdentity(true);
                  send({ type: 'identity_verified' });
                }}
              >
                {identity
                  ? '✓ Identity confirmed'
                  : simulation
                    ? 'Confirm identity (supervised, simulated)'
                    : 'Confirm identity'}
              </Button>
              <Button onClick={() => send({ type: 'end' })}>End call</Button>
            </div>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!text.trim()) return;
                send({ type: 'text', text: text.trim() });
                setText('');
              }}
            >
              <input
                className={inputClass}
                aria-label="Type as the patient"
                placeholder="Type as the patient…"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <Button type="submit">Send</Button>
            </form>
          </>
        )}
        {summary && <Notice tone="info">{summary} The transcript isn&apos;t stored.</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        {state === 'ended' && (
          <Button
            onClick={() => {
              setState('idle');
              setSummary(null);
              setIdentity(false);
            }}
          >
            Close
          </Button>
        )}
      </div>
    </Card>
  );
}
