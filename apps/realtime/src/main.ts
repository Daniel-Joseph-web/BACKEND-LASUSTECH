import http from 'node:http';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { setupRealtimeServer } from './modules/monitoring/socket';

const PORT = Number(process.env.PORT || 3002);
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const JWT_SECRET = process.env.JWT_SECRET || '5f2b8a7c9d0e1f3a4b6c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a';
const WEB_ORIGIN = process.env.WEB_ORIGIN || 'http://localhost:3000';

const server = http.createServer((req, res) => {
  // Simple health check endpoint
  if (req.url === '/health' || req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'lasustech-cbt-realtime', port: PORT }));
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

setupRealtimeServer(server, {
  redisUrl: REDIS_URL,
  jwtSecret: JWT_SECRET,
  webOrigin: WEB_ORIGIN,
});

server.listen(PORT, () => {
  console.log(`📡 LASUSTECH CBT Realtime WebSocket server listening on port ${PORT}`);
  console.log(`🌐 Allowed Web Origin: ${WEB_ORIGIN}`);
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
