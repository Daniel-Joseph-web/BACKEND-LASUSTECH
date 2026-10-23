import { Request, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { Errors } from '../../lib/errors';
import { uuidParam } from '../../lib/http';
import {
  deleteMediaFile,
  mediaView,
  persistImage,
  resolveMediaFile,
} from '../../lib/media';

/** POST /lecturer/media — image upload for a question stem or option. */
export const uploadMedia = async (req: Request, res: Response) => {
  if (!req.file) {
    throw Errors.badRequest('NO_FILE', 'Choose an image to upload.');
  }

  try {
    const asset = await persistImage(prisma, req.file.buffer, req.file.mimetype, {
      uploadedBy: req.auth!.userId,
      altText: req.body?.altText,
    });
    res.status(201).json({ data: mediaView(asset) });
  } catch (error) {
    throw Errors.badRequest(
      'UNSUPPORTED_IMAGE',
      error instanceof Error ? error.message : 'The image could not be stored.',
    );
  }
};

/**
 * GET /media/:id — public on purpose. Public-exam candidates are anonymous and
 * question figures must render for them.
 */
export const getMediaFile = async (req: Request, res: Response) => {
  const found = await resolveMediaFile(prisma, uuidParam(req));
  if (!found) throw Errors.notFound('Image');

  const etag = `"${found.asset.sha256}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Content-Type', found.asset.mime);
  res.setHeader('Content-Disposition', 'inline');
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }
  res.sendFile(found.filePath);
};

/** DELETE /lecturer/media/:id — only while nothing references the image. */
export const deleteMedia = async (req: Request, res: Response) => {
  const id = uuidParam(req);
  const userId = req.auth!.userId;
  const asset = await prisma.mediaAsset.findUnique({ where: { id } });
  if (!asset) throw Errors.notFound('Image');
  if (asset.uploadedBy && asset.uploadedBy !== userId) throw Errors.forbidden();

  const [stemUses, optionUses] = await Promise.all([
    prisma.questionVersion.count({ where: { stemMediaId: id } }),
    prisma.option.count({ where: { mediaId: id } }),
  ]);
  if (stemUses + optionUses > 0) {
    throw Errors.conflict(
      'MEDIA_IN_USE',
      'This image is attached to a question. Remove it from the question first.',
    );
  }

  await prisma.mediaAsset.delete({ where: { id } });
  deleteMediaFile(asset.objectKey);
  res.status(204).end();
};
