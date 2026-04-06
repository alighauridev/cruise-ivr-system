import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import http from 'http';
import { parse } from 'url';
import next from 'next';
import { WebSocketServer } from 'ws';
import { handleMediaStream } from './server/media-ws';

const dev = process.env.NODE_ENV !== 'production';
const port = parseInt(process.env.PORT ?? '3003', 10);

const app = next({ dev, port });
const handle = app.getRequestHandler();

// Create WebSocket server BEFORE Next.js prepare so our handler wins
const wss = new WebSocketServer({ noServer: true });
wss.on('connection', (ws, req) => {
  handleMediaStream(ws, req);
});

app.prepare().then(() => {
  const httpServer = http.createServer((req, res) => {
    const parsedUrl = parse(req.url ?? '/', true);
    handle(req, res, parsedUrl);
  });

  // Register our upgrade handler FIRST — before Next.js upgrade handler.
  // This ensures /media-stream WebSocket is always caught by our WSS,
  // not swallowed by Next.js internals.
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
