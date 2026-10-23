import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(3001),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  // Shared with the worker so images extracted from documents and images
  // uploaded through the API land in the same directory in development.
  MEDIA_UPLOAD_DIR: z.string().optional(),
});

// Process refuses to start if anything is missing or invalid.
export const env = schema.parse(process.env);