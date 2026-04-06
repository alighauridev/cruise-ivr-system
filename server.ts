import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import http from 'http';
import https from 'https';
import { parse } from 'url';
import next from 'next';
import { WebSocketServer } from 'ws';
import { handleMediaStream } from './server/media-ws';
import sql from '@/lib/db';

const dev = process.env.NODE_ENV !== 'production';
const port = parseInt(process.env.PORT ?? '3003', 10);

const app = next({ dev, port });
const handle = app.getRequestHandler();

// Create WebSocket server BEFORE Next.js prepare so our handler wins
const wss = new WebSocketServer({ noServer: true });
wss.on('connection', (ws, req) => {
  handleMediaStream(ws, req);
});

/**
 * Pipe a Twilio recording to the browser using raw Node.js https.request.
 * This bypasses Next.js entirely — no buffering, no timeouts from the framework.
 */
async function handleRecordingProxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  callId: string
) {
  try {
    const rows = await sql`SELECT recording_url FROM calls WHERE id = ${callId} LIMIT 1`;
    const recordingUrl = rows[0]?.recording_url as string | undefined;

    if (!recordingUrl) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const sid = process.env.TWILIO_ACCOUNT_SID ?? '';
    const token = process.env.TWILIO_AUTH_TOKEN ?? '';
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');
    const parsed = new URL(recordingUrl);

    const twilioReq = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: { Authorization: `Basic ${auth}` },
      },
      (twilioRes) => {
        res.writeHead(twilioRes.statusCode ?? 200, {
          'Content-Type': twilioRes.headers['content-type'] ?? 'audio/mpeg',
          'Content-Length': twilioRes.headers['content-length'] ?? '',
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, max-age=3600',
        });
        twilioRes.pipe(res);
      }
    );

    twilioReq.on('error', (err) => {
      console.error('[Recording] Twilio fetch error:', err.message);
      if (!res.headersSent) {
        res.writeHead(502);
        res.end('Recording fetch failed');
      }
    });

    req.on('close', () => twilioReq.destroy());
    twilioReq.end();
  } catch (err: any) {
    console.error('[Recording] Handler error:', err.message);
    if (!res.headersSent) {
      res.writeHead(500);
      res.end('Internal error');
    }
  }
}

app.prepare().then(() => {
  const httpServer = http.createServer((req, res) => {
    const parsedUrl = parse(req.url ?? '/', true);
    const { pathname } = parsedUrl;

    // Intercept recording proxy requests before Next.js to avoid buffering/timeouts
    const recordingMatch = pathname?.match(/^\/api\/calls\/([^/]+)\/recording$/);
    if (recordingMatch && req.method === 'GET') {
      handleRecordingProxy(req, res, recordingMatch[1]);
      return;
    }

    handle(req, res, parsedUrl);
  });

  httpServer.on('upgrade', async (req, socket, head) => {
    const { pathname } = parse(req.url ?? '/');
    if (pathname === '/media-stream') {
      console.log(`[WS] Upgrade request for /media-stream from ${req.socket.remoteAddress}`);
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } else {
      const nextUpgradeHandler = app.getUpgradeHandler();
      await nextUpgradeHandler(req, socket, head);
    }
  });

  httpServer.listen(port, () => {
    console.log(`> Ready on http://localhost:${port}`);
    console.log(`> WebSocket server ready at ws://localhost:${port}/media-stream`);
  });
});
