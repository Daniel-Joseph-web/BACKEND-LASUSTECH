/**
 * Unified Production Entrypoint for LASUSTECH CBT
 * 
 * Runs the REST API, Realtime WebSocket Server, and Background Worker
 * together inside a SINGLE service/container to prevent server overload,
 * eliminate split cold-starts, and conserve free tier hours.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const processes = [];

function startProcess(name, scriptPath, customEnv = {}) {
  console.log(`[Supervisor] Starting ${name}...`);
  const child = spawn(
    'node',
    ['-r', './node_modules/ts-node/register/transpile-only.js', scriptPath],
    {
      cwd: rootDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        ...customEnv,
      },
    }
  );

  child.on('exit', (code, signal) => {
    console.warn(`[Supervisor] ${name} exited with code ${code} (${signal})`);
  });

  processes.push(child);
  return child;
}

// 1. Launch Realtime WebSocket Server on localhost:3002 (internal to the container)
startProcess('Realtime-WebSocket-Engine', 'apps/realtime/src/main.ts', {
  PORT: '3002',
});

// 2. Launch Background Queue Worker
startProcess('Background-Import-Worker', 'apps/worker/src/main.ts', {
  PORT: '3003',
});

// 3. Launch Main Public REST API on port 3001
startProcess('Public-REST-API', 'apps/api/src/main.ts', {
  PORT: process.env.PORT || '3001',
});

// Graceful shutdown forwarding
function shutdown() {
  console.log('\n[Supervisor] Shutting down all unified services...');
  for (const p of processes) {
    p.kill('SIGTERM');
  }
  setTimeout(() => process.exit(0), 2000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
