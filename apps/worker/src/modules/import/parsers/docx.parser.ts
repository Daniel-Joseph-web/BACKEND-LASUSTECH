import mammoth = require('mammoth');
import { ExtractedImage } from '../services/media-storage.service';

export interface DocxExtractionResult {
  textWithPlaceholders: string;
  images: ExtractedImage[];
}

export class DocxParser {
  static async extract(buffer: Buffer): Promise<DocxExtractionResult> {
    const images: ExtractedImage[] = [];

    const result = await mammoth.convertToHtml(
      { buffer },
      {
        convertImage: mammoth.images.imgElement((element) => {
          // element.read('base64') resolves to Base64-encoded text, so
          // imageBuffer is a string. The annotation is a safety net — the
          // real fix is having `mammoth` installed so `element` itself is
          // typed (otherwise `element.read`/`element.contentType` are `any`).
          return element.read('base64').then((imageBuffer: string) => {
            const index = images.length;
            const placeholderId = `[IMG_REF_${index}]`;

            images.push({
              placeholderId,
              buffer: Buffer.from(imageBuffer, 'base64'),
              mime: element.contentType || 'image/png',
            });

            // Replaces image location in document text with the placeholder token
            return { src: placeholderId };
          });
        }),
      },
    );

    // Convert HTML tags to plain text while retaining line breaks and placeholders
    const textWithPlaceholders = result.value
      .replace(/<img[^>]*src="(\[IMG_REF_\d+\])"[^>]*>/gi, '\n$1\n')
      .replace(/<[^>]+>/g, '\n')
      .replace(/\n\s*\n/g, '\n\n')
      .trim();

    return {
      textWithPlaceholders,
      images,
    };
  }
}