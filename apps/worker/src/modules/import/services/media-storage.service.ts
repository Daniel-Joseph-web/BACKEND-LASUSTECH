import { PrismaClient } from '@lasustech-cbt/db';
import { ensureMediaDir, persistImage as persistMedia } from '../../../../../api/src/lib/media';

const prisma = new PrismaClient();

export interface ExtractedImage {
  placeholderId: string; // e.g. "IMG_REF_0"
  buffer: Buffer;
  mime: string;
}

/**
 * Persists figures extracted from documents through the same content-addressed
 * store the API uses, so /api/v1/media/:id serves imported and uploaded images
 * identically and the same file is never stored twice.
 */
export class MediaStorageService {
  static async init() {
    ensureMediaDir();
  }

  static async persistImage(image: ExtractedImage, _scopeId?: string): Promise<string> {
    await this.init();
    const asset = await persistMedia(prisma, image.buffer, image.mime, {
      altText: 'Extracted question or option figure',
    });
    return asset.id;
  }
}
