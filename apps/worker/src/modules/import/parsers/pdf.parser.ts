import pdfParse from 'pdf-parse';

export class PdfParser {
  static async extract(buffer: Buffer): Promise<{ rawText: string }> {
    const fn = typeof pdfParse === 'function' ? pdfParse : (pdfParse as any)?.default;
    if (typeof fn !== 'function') {
      throw new Error('pdf-parse module is not callable.');
    }
    const data = await fn(buffer);
    return { rawText: data?.text || '' };
  }
}
