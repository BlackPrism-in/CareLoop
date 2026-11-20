import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { loadConfig, type AppConfig, type Case, type Site, type Tenant } from '@careloop/contracts';
import {
  conversationSystemPrompt,
  COORDINATION_PROMPT,
  CONVERSATION_PROMPT,
  createGenAIClient,
  GenAiJsonModel,
  type JsonModel,
} from '@careloop/ai';
import { consumeVoiceTicket, tenantDoc, tenantRecord } from '@careloop/domain';
import { createJobRuntime } from '@careloop/jobs';
import { createLogger, newCorrelationId, type Logger } from '@careloop/observability';
import { VoiceSessionController, type ClientMessage, type ServerMessage } from './controller';
import { GenAiLiveConnector, type LiveConnector } from './live';

const ACTION_LABEL = {
  CONSULTATION: 'clinic consultation',
  ORDERED_TEST: 'already-ordered test',
} as const;

export interface GatewayDeps {
  cfg: AppConfig;
  db: Firestore;
  live: LiveConnector;
  coordinationModel: JsonModel | null;
  log: Logger;
  runtime?: ReturnType<typeof createJobRuntime>;
}

/**
 * Voice gateway (MVP spec §11). Browser → WSS → this server → Live model.
 * - Origin allow-list on upgrade; the single-use ticket arrives as the first
 *   message (never in the URL), within 5 seconds.
 * - No model key ever reaches the browser.
 * - The session is capped below the Cloud Run request timeout.
 */
export function createVoiceServer(deps: GatewayDeps) {
  const { cfg, db, log } = deps;
  const runtime = deps.runtime ?? createJobRuntime(cfg, db, log);
  const allowed = new Set(
    cfg.VOICE_ALLOWED_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const server = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          service: 'careloop-voice',
          capSeconds: cfg.VOICE_SESSION_MAX_SECONDS,
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const origin = req.headers.origin ?? '';
    if (path !== '/v1/voice/connect' || !allowed.has(origin)) {
      log.warn('voice upgrade refused', { path, originAllowed: allowed.has(origin) });
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handle(ws));
  });

  function handle(ws: WebSocket) {
    const correlationId = newCorrelationId();
    const send = (m: ServerMessage) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
    let controller: VoiceSessionController | null = null;
    const authTimer = setTimeout(() => ws.close(4401, 'auth timeout'), 5000);

    ws.on('message', async (raw) => {
      let msg: (ClientMessage & { ticket?: string }) | { type: 'auth'; ticket: string };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!controller) {
        if (msg.type !== 'auth' || typeof (msg as { ticket?: unknown }).ticket !== 'string')
          return ws.close(4401, 'auth required');
        clearTimeout(authTimer);
        try {
          controller = await open((msg as { ticket: string }).ticket, correlationId, send);
        } catch (e) {
          send({ type: 'error', message: friendly((e as Error).message) });
          log.warn('voice session not started', { correlationId, reason: (e as Error).message });
          ws.close(4400, 'not started');
        }
        return;
      }
      await controller
        .onClientMessage(msg as ClientMessage)
        .catch((e: Error) => log.warn('voice message failed', { correlationId, error: e.message }));
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      void controller?.end('CLIENT_DISCONNECTED');
    });
  }

  async function open(ticket: string, correlationId: string, send: (m: ServerMessage) => void) {
    const t = await consumeVoiceTicket(db, ticket);
    if (!t) throw new Error('INVALID_TICKET');
    const [tenantSnap, caseSnap] = await Promise.all([
      db.doc(tenantDoc(t.tenantId)).get(),
      db.doc(tenantRecord(t.tenantId, 'cases', t.caseId)).get(),
    ]);
    const tenant = tenantSnap.data() as Tenant | undefined;
    const c = caseSnap.data() as Case | undefined;
    if (!tenant || !c) throw new Error('CASE_NOT_FOUND');
    const site = (await db.doc(tenantRecord(t.tenantId, 'sites', c.siteId)).get()).data() as
      Site | undefined;
    const tz = site?.timeZone ?? cfg.SITE_TIMEZONE;
    const caseAudioLeft = cfg.MAX_CASE_AUDIO_SECONDS - c.audioSecondsUsed;
    if (caseAudioLeft <= 10) throw new Error('AUDIO_BUDGET_EXHAUSTED');
    const capSeconds = Math.min(cfg.VOICE_SESSION_MAX_SECONDS, caseAudioLeft);
    const due = new Intl.DateTimeFormat('en-IN', {
      timeZone: tz,
      day: 'numeric',
      month: 'long',
    }).format(new Date(c.dueAt));

    const controller = new VoiceSessionController(
      {
        tenantId: t.tenantId,
        caseId: t.caseId,
        interactionId: t.interactionId,
        createdBy: t.createdBy,
        correlationId,
        simulation: tenant.simulation,
        labName: tenant.displayName,
        siteTimeZone: tz,
      },
      {
        db,
        commands: runtime.commands,
        booking: runtime.booking,
        dispatcher: runtime.dispatcher,
        live: deps.live,
        coordinationModel: deps.coordinationModel,
        models: { live: cfg.LIVE_MODEL_ID, coordination: cfg.COORDINATION_MODEL_ID },
        promptVersions: {
          conversation: CONVERSATION_PROMPT.version,
          coordination: COORDINATION_PROMPT.version,
        },
        system: conversationSystemPrompt({
          labName: tenant.displayName,
          actionLabel: ACTION_LABEL[c.actionType],
          dueDateLocal: due,
          language: c.language,
          simulation: tenant.simulation,
        }),
        capSeconds,
        log: log.child({ interactionId: t.interactionId }),
      },
      send,
    );
    try {
      await controller.start();
    } catch (e) {
      await controller.end('CONNECT_FAILED');
      throw e;
    }
    return controller;
  }

  return { server, wss };
}

function friendly(reason: string): string {
  if (reason === 'INVALID_TICKET') return 'This call link has expired. Start the call again.';
  if (reason === 'AUDIO_BUDGET_EXHAUSTED')
    return 'The voice time budget for this case is used up. Hand it to staff.';
  if (reason.startsWith('CASE_NOT_IN_CONTACT')) return 'The case is not ready for a call.';
  if (reason === 'PATIENT_SUPPRESSED') return 'The patient has opted out of automated contact.';
  return 'The voice model could not be reached. Check the Gemini configuration (pnpm check:models).';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const log = createLogger('careloop-voice');
  const cfg = loadConfig();
  if (cfg.VOICE_ADAPTER !== 'browser') throw new Error('Only VOICE_ADAPTER=browser is implemented');
  const app = getApps()[0] ?? initializeApp({ projectId: cfg.GOOGLE_CLOUD_PROJECT });
  const db = getFirestore(app);
  let coordinationModel: JsonModel | null = null;
  let live: LiveConnector;
  try {
    coordinationModel = new GenAiJsonModel(createGenAIClient(cfg));
    live = new GenAiLiveConnector(createGenAIClient(cfg, { purpose: 'live' }));
  } catch (e) {
    log.warn('Gemini client not configured; voice sessions will fail to start', {
      error: (e as Error).message,
    });
    live = { connect: async () => Promise.reject(new Error('MODEL_NOT_CONFIGURED')) };
  }
  const port = Number(process.env.PORT ?? 8082);
  createVoiceServer({ cfg, db, live, coordinationModel, log }).server.listen(port, () =>
    log.info('listening', { port, liveModel: cfg.LIVE_MODEL_ID }),
  );
}
