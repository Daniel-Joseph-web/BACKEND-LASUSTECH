import { PrismaClient } from '@lasustech-cbt/db';

function getOptimizedDatabaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;
  if (url.includes('connection_limit=')) return url;
  const separator = url.includes('?') ? '&' : '?';
  // Connection pool size 15 with 20s timeout ensures stable operation under max_connections=100
  return `${url}${separator}connection_limit=15&pool_timeout=20`;
}

export const prisma = new PrismaClient({
  datasources: {
    db: {
      url: getOptimizedDatabaseUrl(),
    },
  },
});
