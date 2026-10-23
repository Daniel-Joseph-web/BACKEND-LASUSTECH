
import * as xlsx from 'xlsx';
import { PDFParse } from 'pdf-parse';
import mammoth = require('mammoth');
import { Errors } from '../../lib/errors';

export type QuestionDifficulty = 'EASY' | 'MEDIUM' | 'HARD';

export interface ParsedOption {
  position: number;
  body: { text: string };
  isCorrect: boolean;
}

export interface ParsedQuestion {
  stem: { text: string };
  options: ParsedOption[];
  difficulty?: QuestionDifficulty;
}

export interface ParseWithAIResult {
  questions: ParsedQuestion[];
  images: unknown[];
}

type SpreadsheetRow = Record<string, unknown>;

export class DocumentParserService {
  /**
   * Deterministic parsing for XLSX and CSV files.
   *
   * Expected columns:
   * Question, Option A, Option B, Option C, Option D,
   * Correct Answer, Difficulty
   */
  static async parseSpreadsheet(
    buffer: Buffer,
  ): Promise<ParsedQuestion[]> {
    const workbook = xlsx.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];

    if (!sheetName) {
      throw Errors.badRequest(
        'EMPTY_SPREADSHEET',
        'The spreadsheet does not contain a worksheet.',
      );
    }

    const worksheet = workbook.Sheets[sheetName];

    if (!worksheet) {
      throw Errors.badRequest(
        'EMPTY_SPREADSHEET',
        'The first worksheet could not be read.',
      );
    }

    const rows = xlsx.utils.sheet_to_json<SpreadsheetRow>(worksheet, {
      defval: '',
      raw: false,
    });

    if (rows.length === 0) {
      throw Errors.badRequest(
        'EMPTY_SPREADSHEET',
        'The spreadsheet contains no question rows.',
      );
    }

    return rows.map((row, index) => {
      const questionText = String(row['Question'] ?? '').trim();

      if (!questionText) {
        throw Errors.badRequest(
          'INVALID_QUESTION_ROW',
          `Row ${index + 2} is missing the Question value.`,
        );
      }

      const answerChar = String(
        row['Correct Answer'] ?? '',
      )
        .trim()
        .toUpperCase();

      if (!['A', 'B', 'C', 'D'].includes(answerChar)) {
        throw Errors.badRequest(
          'INVALID_CORRECT_ANSWER',
          `Row ${index + 2} must specify A, B, C, or D as the Correct Answer.`,
        );
      }

      const optionValues = [
        row['Option A'],
        row['Option B'],
        row['Option C'],
        row['Option D'],
      ];

      const options: ParsedOption[] = optionValues.map(
        (value, position) => ({
          position,
          body: {
            text: String(value ?? '').trim(),
          },
          isCorrect: answerChar === String.fromCharCode(65 + position),
        }),
      );

      if (options.some((option) => !option.body.text)) {
        throw Errors.badRequest(
          'MISSING_OPTION',
          `Row ${index + 2} must contain all four options.`,
        );
      }

      const rawDifficulty = String(
        row['Difficulty'] ?? 'MEDIUM',
      )
        .trim()
        .toUpperCase();

      const difficulty: QuestionDifficulty =
        rawDifficulty === 'EASY' ||
        rawDifficulty === 'HARD' ||
        rawDifficulty === 'MEDIUM'
          ? rawDifficulty
          : 'MEDIUM';

      return {
        stem: { text: questionText },
        difficulty,
        options,
      };
    });
  }

  /**
   * Extracts questions from PDF, DOCX, or plain-text files using
   * Cloudflare AI.
   *
   * This API-side implementation extracts DOCX text only.
   * Embedded DOCX image extraction and storage should be handled
   * by the worker's DOCX parser and media-storage service.
   */
  static async parseWithAI(
    buffer: Buffer,
    mimetype: string,
  ): Promise<ParseWithAIResult> {
    if (!buffer.length) {
      throw Errors.badRequest(
        'EMPTY_FILE',
        'The uploaded document is empty.',
      );
    }

    let rawText = '';

    if (mimetype === 'application/pdf') {
      const parser = new PDFParse({
        data: new Uint8Array(buffer),
      });

      try {
        const result = await parser.getText();
        rawText = result.text;
      } finally {
        await parser.destroy();
      }
    } else if (
      mimetype ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ) {
      const result = await mammoth.extractRawText({
        buffer,
      });

      rawText = result.value;
    } else if (
      mimetype === 'text/plain' ||
      mimetype === 'text/csv'
    ) {
      rawText = buffer.toString('utf-8');
    } else {
      throw Errors.badRequest(
        'UNSUPPORTED_DOCUMENT_TYPE',
        `Unsupported document type: ${mimetype}`,
      );
    }

    rawText = rawText.trim();

    if (!rawText) {
      throw Errors.badRequest(
        'NO_DOCUMENT_TEXT',
        'No readable text was found in the uploaded document.',
      );
    }

    const accountId = process.env.CF_ACCOUNT_ID;
    const apiToken = process.env.CF_API_TOKEN;

    if (!accountId || !apiToken) {
      throw Errors.badRequest(
        'CF_UNCONFIGURED',
        'Cloudflare AI credentials are missing from the environment.',
      );
    }

    const url =
      `https://api.cloudflare.com/client/v4/accounts/` +
      `${accountId}/ai/run/@cf/meta/llama-3.1-8b-instruct`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content: `
You extract multiple-choice examination questions from documents.

Return ONLY a valid JSON array. Do not use Markdown code fences.

Each question must follow this schema:
{
  "stem": { "text": "Question text" },
  "difficulty": "EASY",
  "options": [
    {
      "position": 0,
      "body": { "text": "Option A" },
      "isCorrect": true
    },
    {
      "position": 1,
      "body": { "text": "Option B" },
      "isCorrect": false
    }
  ]
}

Rules:
- Extract only questions supported by the document.
- Include all available answer options.
- Use sequential option positions starting at zero.
- Exactly one option should be marked correct when the answer is identifiable.
- If the correct answer cannot be identified, do not guess.
- Use EASY, MEDIUM, or HARD for difficulty.
- Do not invent missing question text or options.
- Return an empty array if no multiple-choice questions are found.
            `.trim(),
          },
          {
            role: 'user',
            content:
              `Extract the multiple-choice questions from this document:\n\n` +
              rawText.slice(0, 20000),
          },
        ],
      }),
    });

    if (!response.ok) {
      throw Errors.badRequest(
        'AI_EXTRACTION_FAILED',
        `Cloudflare AI returned HTTP ${response.status}.`,
      );
    }

    const payload: unknown = await response.json();

    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('result' in payload) ||
      typeof payload.result !== 'object' ||
      payload.result === null ||
      !('response' in payload.result) ||
      typeof payload.result.response !== 'string'
    ) {
      throw Errors.badRequest(
        'AI_INVALID_RESPONSE',
        'Cloudflare AI returned an unexpected response format.',
      );
    }

    const responseText = payload.result.response
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    let parsed: unknown;

    try {
      parsed = JSON.parse(responseText);
    } catch {
      throw Errors.badRequest(
        'AI_PARSE_ERROR',
        'Cloudflare AI returned invalid JSON.',
      );
    }

    if (!Array.isArray(parsed)) {
      throw Errors.badRequest(
        'AI_INVALID_QUESTIONS',
        'The AI response must be a JSON array of questions.',
      );
    }

    const questions: ParsedQuestion[] = parsed.map(
      (item: unknown, index: number) => {
        if (
          typeof item !== 'object' ||
          item === null ||
          !('stem' in item) ||
          typeof item.stem !== 'object' ||
          item.stem === null ||
          !('text' in item.stem) ||
          typeof item.stem.text !== 'string' ||
          !item.stem.text.trim() ||
          !('options' in item) ||
          !Array.isArray(item.options)
        ) {
          throw Errors.badRequest(
            'AI_INVALID_QUESTION',
            `The AI returned an invalid question at position ${index + 1}.`,
          );
        }

        const options: ParsedOption[] = item.options.map(
          (option: unknown, optionIndex: number) => {
            if (
              typeof option !== 'object' ||
              option === null ||
              !('body' in option) ||
              typeof option.body !== 'object' ||
              option.body === null ||
              !('text' in option.body) ||
              typeof option.body.text !== 'string' ||
              !('isCorrect' in option) ||
              typeof option.isCorrect !== 'boolean'
            ) {
              throw Errors.badRequest(
                'AI_INVALID_OPTION',
                `Question ${index + 1} contains an invalid option.`,
              );
            }

            return {
              position: optionIndex,
              body: {
                text: option.body.text.trim(),
              },
              isCorrect: option.isCorrect,
            };
          },
        );

        if (
          options.length < 2 ||
          options.some((option) => !option.body.text)
        ) {
          throw Errors.badRequest(
            'AI_INVALID_OPTIONS',
            `Question ${index + 1} must contain at least two non-empty options.`,
          );
        }

        const correctCount = options.filter(
          (option) => option.isCorrect,
        ).length;

        if (correctCount !== 1) {
          throw Errors.badRequest(
            'AI_INVALID_ANSWER',
            `Question ${index + 1} must have exactly one correct option. Please review the extracted answer.`,
          );
        }

        const rawDifficulty =
          'difficulty' in item &&
          typeof item.difficulty === 'string'
            ? item.difficulty.toUpperCase()
            : 'MEDIUM';

        const difficulty: QuestionDifficulty =
          rawDifficulty === 'EASY' ||
          rawDifficulty === 'HARD' ||
          rawDifficulty === 'MEDIUM'
            ? rawDifficulty
            : 'MEDIUM';

        return {
          stem: {
            text: item.stem.text.trim(),
          },
          difficulty,
          options,
        };
      },
    );

    return {
      questions,
      images: [],
    };
  }
}
