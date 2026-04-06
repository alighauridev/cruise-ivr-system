import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { parse } from 'url';
import next from 'next';
import { WebSocketServer } from 'ws';
import { handleMediaStream } from './server/media-ws';
import sql from '@/lib/db';

const dev = process.env.NODE_ENV !== 'production';
const port = parseInt(process.env.PORT ?? '3003', 10);

const app = next({ dev, port });
const handle = app.getRequestHandler();

const wss = new WebSocketServer({ noServer: true });
wss.on('connection', (ws, req) => {
  handleMediaStream(ws, req);
});

// In-memory cache: callId → recording URL (avoids repeated DB hits)
const recordingUrlCache = new Map<string, string>();

async function handleRecordingProxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  callId: string
) {
  try {
    // Check memory cache first
    let recordingUrl = recordingUrlCache.get(callId);

    if (!recordingUrl) {
      console.log(`[Recording] DB lookup for callId=${callId}`);
      const rows = await Promise.race([
        sql`SELECT recording_url FROM calls WHERE id = ${callId} LIMIT 1`,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('DB timeout')), 8_000)
        ),
      ]);
      recordingUrl = (rows as any)[0]?.recording_url as string | undefined;

      if (!recordingUrl) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      recordingUrlCache.set(callId, recordingUrl);
    }

    const sid = process.env.TWILIO_ACCOUNT_SID ?? '';
    const token = process.env.TWILIO_AUTH_TOKEN ?? '';
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');
    const parsed = new URL(recordingUrl);

    console.log(`[Recording] Piping from Twilio for callId=${callId}`);

    const twilioReq = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: { Authorization: `Basic ${auth}` },
        timeout: 20_000,
      },
      (twilioRes) => {
        console.log(`[Recording] Twilio responded ${twilioRes.statusCode} for callId=${callId}`);
        const headers: Record<string, string> = {
          'Content-Type': twilioRes.headers['content-type'] ?? 'audio/mpeg',
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, max-age=3600',
        };
        if (twilioRes.headers['content-length']) {
          headers['Content-Length'] = twilioRes.headers['content-length'];
        }
        res.writeHead(twilioRes.statusCode ?? 200, headers);
        twilioRes.pipe(res);
        twilioRes.on('error', (e) => console.error('[Recording] Twilio stream error:', e.message));
      }
    );

    twilioReq.on('timeout', () => {
      console.error('[Recording] Twilio request timed out');
      twilioReq.destroy();
      if (!res.headersSent) {
        res.writeHead(504);
        res.end('Twilio timeout');
      }
    });

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

    // Intercept recording proxy before Next.js
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
