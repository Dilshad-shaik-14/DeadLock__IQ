/**
 * DeadLockIQ Unified Full-Stack Gateway & Go Concurrency Engine Host
 *
 * This server runs on port 3000 to serve the Vite React SPA and proxies all
 * high-performance concurrency operations, distributed locks, Wait-For-Graph
 * evaluations, cycle detections, recovery, and WebSockets directly to the
 * native Go backend engine (backend/deadlockiq-server) running on port 8080.
 */

import express from 'express';
import http from 'http';
import net from 'net';
import path from 'path';
import fs from 'fs';
import { spawn, execSync, ChildProcess } from 'child_process';
import { createServer as createViteServer } from 'vite';

const app = express();
const port = 3000;
const GO_PORT = 8085;

let goProcess: ChildProcess | null = null;

// Ensure Go binary exists and start it
function startGoBackend(): Promise<void> {
  return new Promise((resolve, reject) => {
    const backendDir = path.resolve(process.cwd(), 'backend');
    const binaryName = process.platform === 'win32' ? 'deadlockiq-server.exe' : 'deadlockiq-server';
    const binaryPath = path.resolve(backendDir, binaryName);

    if (!fs.existsSync(binaryPath)) {
      console.log('[DeadLockIQ Gateway] Building Go backend binary...');
      try {
        execSync(`go build -o ${binaryName} cmd/server/main.go`, {
          cwd: backendDir,
          stdio: 'inherit',
        });
        console.log('[DeadLockIQ Gateway] Go backend binary compiled successfully.');
      } catch (err) {
        console.error('[DeadLockIQ Gateway] Failed to compile Go backend:', err);
        return reject(err);
      }
    }

    console.log(`[DeadLockIQ Gateway] Launching Go engine on port ${GO_PORT}...`);
    goProcess = spawn(binaryPath, [], {
      cwd: backendDir,
      env: {
        ...process.env,
        PORT: String(GO_PORT),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    goProcess.stdout?.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) console.log(`[Go Engine] ${msg}`);
    });

    goProcess.stderr?.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) console.error(`[Go Engine Error] ${msg}`);
    });

    goProcess.on('exit', (code, signal) => {
      console.log(`[Go Engine] Exited with code ${code}, signal ${signal}`);
    });

    // Wait until Go backend responds to health checks
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      const req = http.get(`http://127.0.0.1:${GO_PORT}/api/v1/health`, (res) => {
        if (res.statusCode === 200) {
          clearInterval(interval);
          console.log('[DeadLockIQ Gateway] Go backend engine is HEALTHY and ready.');
          resolve();
        }
      });
      req.on('error', () => {
        if (attempts > 30) {
          clearInterval(interval);
          reject(new Error('Timed out waiting for Go backend engine to become healthy'));
        }
      });
    }, 200);
  });
}

// Clean termination handling
process.on('SIGINT', () => {
  if (goProcess) goProcess.kill('SIGINT');
  process.exit(0);
});

process.on('SIGTERM', () => {
  if (goProcess) goProcess.kill('SIGTERM');
  process.exit(0);
});

process.on('exit', () => {
  if (goProcess) goProcess.kill();
});

// Proxy HTTP requests for /api/* and /metrics to Go backend
app.use((req, res, next) => {
  if (req.url.startsWith('/api/') || req.url === '/metrics') {
    const proxyReq = http.request(
      {
        hostname: '127.0.0.1',
        port: GO_PORT,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );

    proxyReq.on('error', (err) => {
      console.error('[DeadLockIQ Gateway] Proxy error to Go backend:', err.message);
      res.status(502).json({ error: 'Go concurrency engine unavailable', details: err.message });
    });

    req.pipe(proxyReq);
  } else {
    next();
  }
});

const server = http.createServer(app);

// Proxy WebSocket upgrade requests for /ws directly to Go backend
server.on('upgrade', (req, socket, head) => {
  if (req.url?.startsWith('/ws')) {
    const proxySocket = net.connect(GO_PORT, '127.0.0.1', () => {
      proxySocket.write(
        `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` +
          Object.entries(req.headers)
            .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}\r\n`)
            .join('') +
          '\r\n'
      );
      if (head && head.length > 0) {
        proxySocket.write(head);
      }
      socket.pipe(proxySocket).pipe(socket);
    });

    proxySocket.on('error', (err) => {
      console.error('[DeadLockIQ Gateway] WebSocket proxy error to Go:', err.message);
      socket.destroy();
    });

    socket.on('error', () => {
      proxySocket.destroy();
    });
  }
});

async function start() {
  await startGoBackend();

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
  }

  server.listen(port, '0.0.0.0', () => {
    console.log(`[DeadLockIQ] Frontend & API Gateway running at http://0.0.0.0:${port}`);
    console.log(`[DeadLockIQ] Real Go engine running on port ${GO_PORT}`);
    console.log(`[DeadLockIQ] WebSocket hub active on ws://0.0.0.0:${port}/ws`);
  });
}

start().catch((err) => {
  console.error('[DeadLockIQ] Startup error:', err);
  process.exit(1);
});
