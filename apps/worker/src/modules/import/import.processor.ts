import { Job } from 'bullmq';
import { PrismaClient, Prisma } from '@lasustech-cbt/db';
import { ImportJobPayload } from '../../../../api/src/lib/queue';
import { SpreadsheetParser, InternalParsedQuestion } from './parsers/spreadsheet.parser';
import { DocxParser } from './parsers/docx.parser';
import { PdfParser } from './parsers/pdf.parser';
import { MediaStorageService } from './services/media-storage.service';
import { CloudflareAiService } from './services/cloudflare-ai.service';

const prisma = new PrismaClient();

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp']);
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'rtf']);

const IMAGE_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

interface PreparedQuestion extends InternalParsedQuestion {
  answerSource: 'SOURCE' | 'AI_SUGGESTED' | 'AI_GENERATED';
}

function cleanText(value: string): string {
  if (!value) return '';
  return value
    .replace(/\[IMG_REF_\d+\]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sourceExplanation(original: string | undefined, note: string): string {
  return [note, original?.trim() ? `Source explanation: ${original.trim()}` : '']
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 2000);
}

/** Strips RTF control words without pulling in a full parser. */
function rtfToText(rtf: string): string {
  return rtf
    .replace(/\\par[d]?/g, '\n')
    .replace(/\{\\\*?[^{}]*\}/g, '')
    .replace(/\\'[0-9a-fA-F]{2}/g, ' ')
    .replace(/\\[a-zA-Z]+-?\d* ?/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/** `.doc` is binary; word-extractor is optional so the failure is actionable. */
async function extractLegacyDoc(buffer: Buffer): Promise<string> {
  // Typed as `string` on purpose: a string literal would make TypeScript
  // resolve the module at compile time and fail the build when the optional
  // package has no bundled declarations.
  const moduleName: string = 'word-extractor';
  let WordExtractor: new (options?: unknown) => { extract: (input: Buffer) => Promise<{ getBody: () => string }> };
  try {
    const mod = (await import(moduleName)) as unknown as {
      default?: typeof WordExtractor;
      WordExtractor?: typeof WordExtractor;
    };
    const ctor = mod.default ?? mod.WordExtractor;
    if (!ctor) throw new Error('module did not export a constructor');
    WordExtractor = ctor;
  } catch {
    throw new Error(
      'Legacy .doc files need the "word-extractor" package. Install it in apps/worker, or save the document as .docx and upload again.',
    );
  }
  const extractor = new WordExtractor();
  const document = await extractor.extract(buffer);
  return document.getBody();
}

function normaliseImageMime(extension: string, mimetype: string): string {
  return IMAGE_MIME[extension] ?? (mimetype.startsWith('image/') ? mimetype : 'image/jpeg');
}

export async function processQuestionImportJob(job: Job<ImportJobPayload>) {
  const { importJobId, courseId, subjectId, topicId, userId, fileBuffer, mimetype, originalName } =
    job.data;

  await prisma.importJob.update({ where: { id: importJobId }, data: { status: 'PROCESSING' } });

  const buffer = Buffer.from(fileBuffer, 'base64');
  const extension = originalName.toLowerCase().split('.').pop() ?? '';
  const placeholderToMediaIdMap = new Map<string, string>();

  let extractedQuestions: PreparedQuestion[] = [];
  let rawText = '';
  let imagesImported = 0;
  let imagesSkipped = 0;
  let aiGenerated = 0;
  let aiAnswered = 0;
  let sourceAnswered = 0;

  try {
    // 1. Extract (or read) the source -------------------------------------
    if (extension === 'csv' || extension === 'xlsx' || extension === 'xls' || mimetype.includes('spreadsheetml') || mimetype === 'text/csv') {
      extractedQuestions = SpreadsheetParser.parse(buffer).map((question) => ({
        ...question,
        answerSource: 'SOURCE',
      }));
    } else if (extension === 'docx' || mimetype.includes('wordprocessingml')) {
      const { textWithPlaceholders, images } = await DocxParser.extract(buffer);
      rawText = textWithPlaceholders;

      for (const image of images) {
        try {
          const mediaId = await MediaStorageService.persistImage(image);
          placeholderToMediaIdMap.set(image.placeholderId, mediaId);
          imagesImported += 1;
        } catch (error) {
          imagesSkipped += 1;
          console.warn(`[Import] Image ${image.placeholderId} could not be stored:`, error);
        }
      }

      extractedQuestions = mapAiQuestions(
        await CloudflareAiService.extractQuestionsFromText(textWithPlaceholders),
        placeholderToMediaIdMap,
      );
    } else if (extension === 'pdf' || mimetype === 'application/pdf') {
      let pdfText = '';
      try {
        const parsed = await PdfParser.extract(buffer);
        pdfText = parsed.rawText || '';
      } catch (err: any) {
        console.warn('[Import] pdf-parse extraction warning:', err?.message);
      }
      rawText = pdfText;

      // 1) Primary path for PDF: Direct multimodal ingestion if Gemini is available
      if (CloudflareAiService.hasGeminiSupport()) {
        try {
          extractedQuestions = mapAiQuestions(
            await CloudflareAiService.extractQuestionsFromPdf(buffer),
            placeholderToMediaIdMap,
          );
        } catch (pdfErr: any) {
          console.warn('[Import] Direct Gemini PDF extraction failed, falling back to text extraction:', pdfErr?.message);
        }
      }

      // 2) Secondary path: Text extraction via parsed text
      if (extractedQuestions.length === 0 && pdfText.trim()) {
        extractedQuestions = mapAiQuestions(
          await CloudflareAiService.extractQuestionsFromText(pdfText),
          placeholderToMediaIdMap,
        );
      }
    } else if (TEXT_EXTENSIONS.has(extension) || mimetype === 'text/plain' || mimetype === 'text/markdown') {
      rawText =
        extension === 'rtf' || mimetype === 'application/rtf' || mimetype === 'text/rtf'
          ? rtfToText(buffer.toString('utf8'))
          : buffer.toString('utf8');
      extractedQuestions = mapAiQuestions(
        await CloudflareAiService.extractQuestionsFromText(rawText),
        placeholderToMediaIdMap,
      );
    } else if (extension === 'doc' || mimetype === 'application/msword') {
      rawText = await extractLegacyDoc(buffer);
      extractedQuestions = mapAiQuestions(
        await CloudflareAiService.extractQuestionsFromText(rawText),
        placeholderToMediaIdMap,
      );
    } else if (IMAGE_EXTENSIONS.has(extension) || mimetype.startsWith('image/')) {
      // A photographed paper or screenshot: needs a vision-capable provider.
      extractedQuestions = mapAiQuestions(
        await CloudflareAiService.extractQuestionsFromImage(
          buffer,
          normaliseImageMime(extension, mimetype),
        ),
        placeholderToMediaIdMap,
      );
    } else {
      throw new Error(`Unsupported file type: ${mimetype} (${originalName}).`);
    }

    // 2. If the document had content but no complete MCQs, ask the model to
    //    build questions from it (this is the "answer even without a key" path).
    if (extractedQuestions.length === 0 && rawText.trim() && !IMAGE_EXTENSIONS.has(extension)) {
      const generated = await CloudflareAiService.generateQuestionsFromText(rawText);
      extractedQuestions = generated.map((question) => ({
        stemText: question.stemText,
        stemMediaId: question.stemPlaceholder
          ? placeholderToMediaIdMap.get(question.stemPlaceholder)
          : undefined,
        difficulty: question.difficulty,
        hasMath: question.hasMath,
        explanation: question.explanation ?? undefined,
        answerSource: 'AI_GENERATED' as const,
        options: question.options.map((option) => ({
          position: option.position,
          text: option.text,
          mediaId: option.mediaPlaceholder
            ? placeholderToMediaIdMap.get(option.mediaPlaceholder)
            : undefined,
          isCorrect: option.isCorrect,
        })),
      }));
      aiGenerated = extractedQuestions.length;
    } else if (
      extractedQuestions.length === 0 &&
      (extension === 'pdf' || mimetype === 'application/pdf') &&
      CloudflareAiService.hasGeminiSupport()
    ) {
      try {
        const generated = await CloudflareAiService.generateQuestionsFromPdf(buffer);
        extractedQuestions = generated.map((question) => ({
          stemText: question.stemText,
          stemMediaId: question.stemPlaceholder
            ? placeholderToMediaIdMap.get(question.stemPlaceholder)
            : undefined,
          difficulty: question.difficulty,
          hasMath: question.hasMath,
          explanation: question.explanation ?? undefined,
          answerSource: 'AI_GENERATED' as const,
          options: question.options.map((option) => ({
            position: option.position,
            text: option.text,
            mediaId: option.mediaPlaceholder
              ? placeholderToMediaIdMap.get(option.mediaPlaceholder)
              : undefined,
            isCorrect: option.isCorrect,
          })),
        }));
        aiGenerated = extractedQuestions.length;
      } catch (genErr: any) {
        console.warn('[Import] PDF question generation failed:', genErr?.message);
      }
    }

    if (extractedQuestions.length === 0) {
      throw new Error(
        'No multiple-choice questions could be read from this document. Check that it contains questions with at least two answer options, or upload a clearer photo/PDF.',
      );
    }

    // 3. Answer unkeyed questions and promote the suggestion to a real key.
    const unsolved = extractedQuestions
      .map((question, originalIndex) => ({ question, originalIndex }))
      .filter(({ question }) => question.options.filter((option) => option.isCorrect).length === 0);

    if (unsolved.length) {
      for (let start = 0; start < unsolved.length; start += 15) {
        const batch = unsolved.slice(start, start + 15);
        try {
          const suggestions = await CloudflareAiService.suggestAnswers(
            batch.map(({ question }) => ({
              stemText: cleanText(question.stemText),
              options: question.options.map((option) => ({
                position: option.position,
                text: cleanText(option.text),
              })),
            })),
          );

          for (const suggestion of suggestions) {
            if (suggestion.optionPosition < 0) continue;
            const originalIndex = batch[suggestion.questionIndex]?.originalIndex;
            if (originalIndex === undefined) continue;
            const question = extractedQuestions[originalIndex];
            const correct = question.options.find(
              (option) => option.position === suggestion.optionPosition,
            );
            if (!correct || correct.isCorrect) continue;

            for (const option of question.options) option.isCorrect = false;
            correct.isCorrect = true;
            question.answerSource = 'AI_SUGGESTED';
            question.explanation = sourceExplanation(
              question.explanation,
              `AI-suggested answer: option ${suggestion.optionPosition + 1}. Rationale: ${suggestion.rationale}`,
            );
            aiAnswered += 1;
          }
        } catch (error) {
          console.warn(
            `[Import] AI answer suggestions unavailable for batch ${Math.floor(start / 15) + 1}.`,
            error,
          );
        }
      }
    }

    // 4. Validate and prepare rows ----------------------------------------
    const prepared: PreparedQuestion[] = [];
    let unanswered = 0;
    let skipped = 0;

    for (let index = 0; index < extractedQuestions.length; index += 1) {
      const question = extractedQuestions[index];
      const stemText = cleanText(question.stemText ?? '');
      const options = question.options
        .map((option) => ({ ...option, text: cleanText(option.text) }))
        .filter((option) => option.text.length > 0);
      const positions = options.map((option) => option.position);
      const correctCount = options.filter((option) => option.isCorrect).length;

      if (!stemText || options.length < 2 || new Set(positions).size !== positions.length) {
        skipped += 1;
        console.warn(`[Import] Skipped question ${index + 1}: missing text or options.`);
        continue;
      }
      if (correctCount > 1) {
        skipped += 1;
        console.warn(`[Import] Skipped question ${index + 1}: more than one correct option.`);
        continue;
      }
      if (correctCount === 0) unanswered += 1;
      if (correctCount === 1 && question.answerSource === 'SOURCE') sourceAnswered += 1;

      prepared.push({
        ...question,
        stemText,
        options,
        // Provenance follows where the key came from: the source, the model's
        // suggestion, or entirely generated questions.
        answerSource: question.answerSource,
      });
    }

    if (!prepared.length) {
      throw new Error(
        'None of the extracted items were usable multiple-choice questions (each needs text and at least two options).',
      );
    }

    const aiModel = CloudflareAiService.modelName();
    const provider = CloudflareAiService.providerName();

    // 5. Persist -----------------------------------------------------------
    const importedIds = await prisma.$transaction(async (tx) => {
      const ids: string[] = [];
      for (const questionData of prepared) {
        // A question without a grounded answer stays DRAFT so it cannot enter
        // an exam until the lecturer picks the correct option.
        const hasAnswer = questionData.options.filter((option) => option.isCorrect).length === 1;
        const status = hasAnswer ? 'APPROVED' : 'DRAFT';

        const question = await tx.question.create({
          data: {
            courseId: courseId ?? null,
            subjectId: subjectId ?? null,
            answerFormat: 'MCQ_SINGLE',
            createdBy: userId,
          },
        });

        const version = await tx.questionVersion.create({
          data: {
            questionId: question.id,
            versionNo: 1,
            stem: { text: questionData.stemText } as Prisma.InputJsonValue,
            stemMediaId: questionData.stemMediaId ?? null,
            hasMath: questionData.hasMath,
            explanation: questionData.explanation,
            topicId,
            difficulty: questionData.difficulty,
            marks: new Prisma.Decimal(1),
            status,
            answerSource: questionData.answerSource,
            aiModel: questionData.answerSource === 'SOURCE' ? null : aiModel,
            authorId: userId,
            approvedBy: hasAnswer ? userId : null,
            approvedAt: hasAnswer ? new Date() : null,
            options: {
              create: questionData.options.map((option) => ({
                position: option.position,
                body: { text: option.text } as Prisma.InputJsonValue,
                mediaId: option.mediaId || null,
                isCorrect: option.isCorrect,
              })),
            },
          },
        });

        await tx.question.update({
          where: { id: question.id },
          data: { currentVersionId: version.id },
        });
        ids.push(question.id);
      }
      return ids;
    });

    const counts = {
      imported: importedIds.length,
      approved: prepared.filter(
        (question) => question.options.filter((option) => option.isCorrect).length === 1,
      ).length,
      sourceAnswered,
      aiAnswered,
      aiGenerated,
      unanswered,
      skipped,
      imagesImported,
      imagesSkipped,
      provider,
      model: aiModel,
    };

    await prisma.importJob.update({
      where: { id: importJobId },
      data: { status: 'COMPLETED', resultObjectKey: JSON.stringify(counts) },
    });

    if (userId) {
      await prisma.notification.create({
        data: {
          userId,
          type: 'SYSTEM',
          title: `Question Import Complete (${counts.imported} questions)`,
          body: `Successfully imported ${counts.imported} questions from "${originalName}".`,
          meta: { kind: 'IMPORT_JOB', importJobId, href: '/lecturer/questions' },
        },
      }).catch(() => {});
    }

    return counts;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown processing error';
    await prisma.importJob.update({
      where: { id: importJobId },
      data: { status: 'FAILED', errors: { message } },
    });

    if (userId) {
      await prisma.notification.create({
        data: {
          userId,
          type: 'SYSTEM',
          title: 'Question Import Failed',
          body: `Failed to import questions from "${originalName}": ${message.slice(0, 160)}`,
          meta: { kind: 'IMPORT_JOB_FAILED', importJobId, href: '/lecturer/questions' },
        },
      }).catch(() => {});
    }

    throw error;
  }
}

function mapAiQuestions(
  questions: Awaited<ReturnType<typeof CloudflareAiService.extractQuestionsFromText>>,
  placeholderToMediaIdMap: Map<string, string>,
): PreparedQuestion[] {
  return questions.map((question, qIdx) => {
    let placeholder = question.stemPlaceholder;
    if (!placeholder) {
      const match = question.stemText.match(/\[IMG_REF_(\d+)\]/);
      if (match) placeholder = match[0];
    }

    const stemMediaId = placeholder
      ? placeholderToMediaIdMap.get(placeholder)
      : placeholderToMediaIdMap.get(`[IMG_REF_${qIdx}]`);

    return {
      stemText: question.stemText,
      stemMediaId: stemMediaId ?? undefined,
      difficulty: question.difficulty,
      hasMath:
        question.hasMath ||
        /<svg[\s\S]*?<\/svg>/i.test(question.stemText) ||
        /\$|\\\(|\\\[/.test(question.stemText),
      explanation: question.explanation ?? undefined,
      answerSource: 'SOURCE' as const,
      options: question.options.map((option) => {
        let optPlaceholder = option.mediaPlaceholder;
        if (!optPlaceholder) {
          const match = option.text.match(/\[IMG_REF_(\d+)\]/);
          if (match) optPlaceholder = match[0];
        }
        return {
          position: option.position,
          text: option.text,
          mediaId: optPlaceholder ? placeholderToMediaIdMap.get(optPlaceholder) : undefined,
          isCorrect: option.isCorrect,
        };
      }),
    };
  });
}
