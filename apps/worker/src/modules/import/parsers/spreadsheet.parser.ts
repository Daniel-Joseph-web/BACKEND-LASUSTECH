import * as xlsx from 'xlsx';

export interface InternalParsedQuestion {
  stemText: string;
  stemMediaId?: string;
  stemPlaceholder?: string;
  difficulty: 'EASY' | 'MEDIUM' | 'HARD';
  explanation?: string;
  hasMath: boolean;
  options: {
    position: number;
    text: string;
    mediaId?: string;
    mediaPlaceholder?: string;
    isCorrect: boolean;
  }[];
}

export class SpreadsheetParser {
  static parse(buffer: Buffer): InternalParsedQuestion[] {
    const workbook = xlsx.read(buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet) as Record<string, any>[];

    return rows.map((row) => {
      const answer = String(row['Correct Answer'] || row['Answer'] || '').trim().toUpperCase();
      const rawOptions = [
        { text: String(row['Option A'] || row['A'] || ''), isCorrect: answer === 'A' },
        { text: String(row['Option B'] || row['B'] || ''), isCorrect: answer === 'B' },
        { text: String(row['Option C'] || row['C'] || ''), isCorrect: answer === 'C' },
        { text: String(row['Option D'] || row['D'] || ''), isCorrect: answer === 'D' },
      ].filter((o) => o.text.trim().length > 0);

      const diff = String(row['Difficulty'] || 'MEDIUM').toUpperCase();
      const difficulty = (['EASY', 'MEDIUM', 'HARD'].includes(diff) ? diff : 'MEDIUM') as 'EASY' | 'MEDIUM' | 'HARD';

      return {
        stemText: String(row['Question'] || row['Stem'] || ''),
        difficulty,
        explanation: row['Explanation'] ? String(row['Explanation']) : undefined,
        hasMath: String(row['Question']).includes('$') || String(row['Question']).includes('\\'),
        options: rawOptions.map((opt, idx) => ({
          position: idx,
          text: opt.text,
          isCorrect: opt.isCorrect,
        })),
      };
    });
  }
}