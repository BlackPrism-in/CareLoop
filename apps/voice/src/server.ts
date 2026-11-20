import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { loadConfig } from '@careloop/contracts';
import { createLogger } from '@careloop/observability';

const log = createLogger('careloop-voice');

/**
 * Voice gateway (MVP spec §11). Phase 4 implements: single-use case-bound
 * session tickets, origin checks, Live model bridging, server-side tool
 * execution and an application session cap below the Cloud Run timeout.
 * Until then every upgrade is refused.
 */
export function createVoiceServer() {
  const cfg = loadConfig();
  const server = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          service: 'careloop-voice',
          maxCaseAudioSeconds: cfg.MAX_CASE_AUDIO_SECONDS,
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket) => {
    log.warn('voice session refused: gateway not implemented', { path: req.url });
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });
  return { server, wss };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8082);
  createVoiceServer().server.listen(port, () => log.info('listening', { port }));
}
