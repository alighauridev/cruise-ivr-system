/**
 * start.ts — single command to start everything:
 *   1. Spin up cloudflared tunnel → capture the public HTTPS URL
 *   2. Write that URL into .env.local as PUBLIC_URL
 *   3. Start the Next.js + WebSocket dev server
 *   4. Pre-warm all Twilio webhook routes (so first real call isn't slow)
 *
 * Run with: pnpm run start:dev
 */

import { spawn, ChildProcess, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';

const ENV_FILE = path.resolve(__dirname, '.env.local');
const LOCAL_PORT = 3003;

/** Kill any process already listening on LOCAL_PORT so we can start fresh. */
function killPortProcess() {
  try {
    // netstat finds the PID holding the port; works on Windows
    const out = execSync(`netstat -ano | findstr :${LOCAL_PORT}`, { encoding: 'utf8', stdio: 'pipe' });
    const lines = out.split('\n').filter((l) => l.includes('LISTENING'));
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && pid !== '0') {
        try {
          execSync(`taskkill /PID ${pid} /F`, { stdio: 'pipe' });
          console.log(`[setup] Killed stale process PID ${pid} on port ${LOCAL_PORT}`);
        } catch { /* already gone */ }
      }
    }
  } catch { /* port is free, nothing to kill */ }
}

function updateEnvPublicUrl(url: string) {
  let content = fs.readFileSync(ENV_FILE, 'utf8');
  if (/^PUBLIC_URL=.*/m.test(content)) {
    content = content.replace(/^PUBLIC_URL=.*$/m, `PUBLIC_URL=${url}`);
  } else {
    content += `\nPUBLIC_URL=${url}\n`;
  }
  fs.writeFileSync(ENV_FILE, content, 'utf8');
  console.log(`\n[setup] PUBLIC_URL updated to: ${url}\n`);
}

function startTunnel(): Promise<{ url: string; proc: ChildProcess }> {
  return new Promise((resolve, reject) => {
    console.log('[setup] Starting cloudflared tunnel...');
    const proc = spawn('npx', ['cloudflared', 'tunnel', '--protocol', 'http2', '--url', `http://localhost:${LOCAL_PORT}`], {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let resolved = false;
    const onData = (data: Buffer) => {
      const text = data.toString();
      process.stdout.write(`[tunnel] ${text}`);
      const match = text.match(/https:\/\/[a-z0-9\-]+\.trycloudflare\.com/);
      if (match && !resolved) {
        resolved = true;
        resolve({ url: match[0], proc });
      }
    };

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    proc.on('exit', (code) => {
      if (!resolved) reject(new Error(`cloudflared exited with code ${code}`));
    });

    setTimeout(() => {
      if (!resolved) reject(new Error('Timed out waiting for tunnel URL'));
    }, 30000);
  });
}

function startDevServer(): { proc: ChildProcess; waitForReady: Promise<void> } {
  console.log('[setup] Starting dev server...');

  // Capture stdout so we can detect when Next.js is ready
  const proc = spawn(
    'npx',
    ['ts-node', '--project', 'tsconfig.server.json', '-r', 'tsconfig-paths/register', 'server.ts'],
    {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    }
  );

  const waitForReady = new Promise<void>((resolve) => {
    let resolved = false;
    const onData = (data: Buffer) => {
      const text = data.toString();
      process.stdout.write(text);
      if (!resolved && text.includes('Ready on http://localhost')) {
        resolved = true;
        resolve();
      }
    };
    proc.stdout!.on('data', onData);
    proc.stderr!.on('data', onData);
    // Safety timeout — resolve anyway after 60s
    setTimeout(() => { if (!resolved) { resolved = true; resolve(); } }, 60000);
  });

  return { proc, waitForReady };
}

function httpPost(path: string): Promise<number> {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: 'localhost', port: LOCAL_PORT, path, method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': 0 } },
      (res) => resolve(res.statusCode ?? 0)
    );
    req.on('error', () => resolve(0));
    req.setTimeout(90000, () => { req.destroy(); resolve(0); });
    req.end();
  });
}

function httpGet(path: string): Promise<number> {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: 'localhost', port: LOCAL_PORT, path, method: 'GET' },
      (res) => resolve(res.statusCode ?? 0)
    );
    req.on('error', () => resolve(0));
    req.setTimeout(90000, () => { req.destroy(); resolve(0); });
    req.end();
  });
}

async function warmupRoutes() {
  console.log('\n[setup] Pre-warming routes (this prevents 60s delay on first call)...');

  const routes: Array<[string, () => Promise<number>]> = [
    ['GET  /api/auth/session', () => httpGet('/api/auth/session')],
    ['POST /api/calls/status', () => httpPost('/api/calls/status')],
    ['POST /api/calls/ivr-handler', () => httpPost('/api/calls/ivr-handler?callId=00000000-0000-0000-0000-000000000000')],
    ['POST /api/calls/initiate', () => httpPost('/api/calls/initiate')],
    ['POST /api/calls/recording', () => httpPost('/api/calls/recording')],
    ['GET  /api/leads', () => httpGet('/api/leads')],
  ];

  for (const [name, fn] of routes) {
    const start = Date.now();
    const status = await fn();
    const ms = Date.now() - start;
    console.log(`[warmup] ${name} → ${status || 'err'} (${ms}ms)`);
  }

  console.log('[setup] Routes warm — ready to place calls!\n');
}

const MAX_RESTARTS = 5;
const RESTART_DELAY_MS = 3000;

async function main() {
  let tunnelProc: ChildProcess | null = null;
  let shuttingDown = false;
  let restartCount = 0;

  const cleanup = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[setup] Shutting down...');
    tunnelProc?.kill();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    killPortProcess();

    const { url, proc: tProc } = await startTunnel();
    tunnelProc = tProc;
    updateEnvPublicUrl(url);

    tunnelProc.on('exit', (code) => {
      if (!shuttingDown) {
        console.error(`[setup] Tunnel exited unexpectedly (${code}) — shutting down`);
        cleanup();
      }
    });

    const launchServer = async () => {
      const { proc: sProc, waitForReady } = startDevServer();

      sProc.on('exit', (code) => {
        if (shuttingDown) return;
        restartCount++;
        if (restartCount > MAX_RESTARTS) {
          console.error(`[setup] Dev server crashed ${restartCount} times — giving up`);
          cleanup();
          return;
        }
        console.log(`\n[setup] Dev server exited (${code}) — restarting in ${RESTART_DELAY_MS / 1000}s (attempt ${restartCount}/${MAX_RESTARTS})...`);
        setTimeout(launchServer, RESTART_DELAY_MS);
      });

      // Wait for Next.js to print "Ready" before warming up routes
      await waitForReady;

      // Warmup errors should never crash the process
      try {
        await warmupRoutes();
      } catch (err) {
        console.error('[setup] Warmup failed (non-fatal):', err);
      }
    };

    await launchServer();

  } catch (err) {
    console.error('[setup] Error:', err);
    tunnelProc?.kill();
    process.exit(1);
  }
}

main();
