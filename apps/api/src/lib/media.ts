import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { PrismaClient } from '@lasustech-cbt/db';

/**
 * Question figures are stored once per content hash and served from
 * /api/v1/media/:id. The database holds the MediaAsset row; the file itself
 * lives under MEDIA_UPLOAD_DIR so it can later be swapped for R2/S3 without
 * changing any question/option data.
 */
export const MEDIA_UPLOAD_DIR = process.env.MEDIA_UPLOAD_DIR
  ? path.resolve(process.env.MEDIA_UPLOAD_DIR)
  : path.resolve(process.cwd(), '../../uploads/media');

export const MEDIA_URL_PREFIX = '/api/v1/media';

export const IMAGE_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export type MediaDb = Pick<PrismaClient, 'mediaAsset'>;

export interface MediaRecord {
  id: string;
  objectKey: string;
  mime: string;
  bytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
  altText: string;
  scanStatus: string;
  createdAt: Date;
}

export interface MediaView {
  id: string;
  url: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  altText: string;
}

export const mediaUrl = (id: string) => `${MEDIA_URL_PREFIX}/${id}`;

export const mediaView = (asset: MediaRecord | null | undefined): MediaView | null =>
  asset
    ? {
        id: asset.id,
        url: mediaUrl(asset.id),
        mime: asset.mime,
        bytes: asset.bytes,
        width: asset.width,
        height: asset.height,
        altText: asset.altText,
      }
    : null;

export function assertImageMime(mime: string): string {
  const ext = IMAGE_MIME_EXT[mime.toLowerCase()];
  if (!ext) {
    throw new Error(`Unsupported image type "${mime}". Use PNG, JPEG, WebP or GIF.`);
  }
  return ext;
}

export function ensureMediaDir() {
  fs.mkdirSync(MEDIA_UPLOAD_DIR, { recursive: true });
}

/**
 * Writes the image (unless an identical file already exists) and returns the
 * MediaAsset row. Accepts any client exposing `mediaAsset` so the API and the
 * BullMQ worker can share this implementation.
 */
export async function persistImage(
  db: MediaDb,
  buffer: Buffer,
  mime: string,
  options: { uploadedBy?: string | null; altText?: string } = {},
): Promise<MediaRecord> {
  if (!buffer.length) throw new Error('The image file is empty.');
  const ext = assertImageMime(mime);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const objectKey = `${sha256}.${ext}`;

  ensureMediaDir();
  const filePath = path.join(MEDIA_UPLOAD_DIR, objectKey);
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, buffer);

  const existing = await db.mediaAsset.findUnique({ where: { sha256 } });
  if (existing) return existing as MediaRecord;

  try {
    const asset = await db.mediaAsset.create({
      data: {
        objectKey,
        mime,
        bytes: buffer.length,
        sha256,
        altText: options.altText?.slice(0, 300) || 'Question figure',
        scanStatus: 'CLEAN',
        uploadedBy: options.uploadedBy ?? null,
      },
    });
    return asset as MediaRecord;
  } catch (error) {
    // Two uploads of the same file can race; the unique sha256 settles it.
    if ((error as { code?: string }).code === 'P2002') {
      const winner = await db.mediaAsset.findUnique({ where: { sha256 } });
      if (winner) return winner as MediaRecord;
    }
    throw error;
  }
}

/** Resolves a MediaAsset id to a path that is guaranteed to be inside the store. */
export async function resolveMediaFile(db: MediaDb, id: string) {
  const asset = (await db.mediaAsset.findUnique({ where: { id } })) as MediaRecord | null;
  if (!asset) return null;
  const fileName = path.basename(asset.objectKey);
  const filePath = path.join(MEDIA_UPLOAD_DIR, fileName);
  if (!filePath.startsWith(MEDIA_UPLOAD_DIR + path.sep) || !fs.existsSync(filePath)) return null;
  return { asset, filePath };
}

export function deleteMediaFile(objectKey: string) {
  const filePath = path.join(MEDIA_UPLOAD_DIR, path.basename(objectKey));
  if (filePath.startsWith(MEDIA_UPLOAD_DIR + path.sep) && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}
