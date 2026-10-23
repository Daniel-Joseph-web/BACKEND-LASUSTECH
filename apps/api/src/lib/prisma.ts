import { PrismaClient } from '@lasustech-cbt/db';

function getOptimizedDatabaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;
  if (url.includes('connection_limit=')) return url;
  const separator = url.includes('?') ? '&' : '?';
  // Connection pool size 50 with 30s timeout accommodates 600 concurrent exam candidates
  return `${url}${separator}connection_limit=50&pool_timeout=30`;
}

export const prisma = new PrismaClient({
  datasources: {
    db: {
      url: getOptimizedDatabaseUrl(),
    },
  },
});
