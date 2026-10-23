import { Router } from 'express';
import multer from 'multer';
import { requireAuth, requireRole } from '../auth/auth.middleware';
import { getDashboardSummary, getLecturerCourses, getLecturerTopics, listExams } from './lecturer.controller';
import { listQuestions, getQuestionById, createQuestion, updateQuestion, deleteQuestion, getQuestionsSummary, bulkApproveQuestions } from './questions.controller';
import { listSubjects, createSubject, updateSubject } from './subjects.controller';
import { uploadMedia, deleteMedia } from './media.controller';
import { downloadTemplate, submitQuestionImportJob, getImportJobStatus } from './import.controller';
import {
  createExam,
  deleteExam,
  getAvailableQuestionCounts,
  getExamById,
  saveExamDraft,
  submitExamForModeration,
  updateExam,
} from './exams.controller';
import { getQuestionSubmissions, reviewQuestionVersion } from './moderation.controller';
import { getExamResults, exportExamResultsCsv, getLecturerAttemptScript } from './results.controller';

export const lecturerRouter = Router();

/**
 * Import accepts documents (office, PDF, plain text) and photos/screenshots of
 * a paper. Browsers disagree about the mimetype of .doc/.md/.rtf, so the
 * extension is the authoritative check and the mimetype list is permissive.
 */
const ALLOWED_IMPORT_TYPES = new Set([
  'text/csv',
  'text/plain',
  'text/markdown',
  'text/rtf',
  'application/rtf',
  'application/csv',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/octet-stream',
]);

const IMPORT_EXTENSIONS = /\.(csv|xlsx|xls|docx|doc|pdf|txt|md|rtf|jpg|jpeg|png|webp)$/i;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!IMPORT_EXTENSIONS.test(file.originalname) || !ALLOWED_IMPORT_TYPES.has(file.mimetype)) {
      return callback(
        new Error(
          'Unsupported file type. Upload CSV, XLSX/XLS, DOCX/DOC, PDF, TXT/MD/RTF, or a JPG/PNG/WebP photo.',
        ),
      );
    }
    callback(null, true);
  },
});

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      return callback(new Error('Only JPG, PNG, WebP or GIF images are supported.'));
    }
    callback(null, true);
  },
});

lecturerRouter.use(requireAuth, requireRole('LECTURER'), (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

lecturerRouter.get('/dashboard/summary', getDashboardSummary);
lecturerRouter.get('/courses', getLecturerCourses);
lecturerRouter.get('/topics', getLecturerTopics);

// Subjects are the non-university escape hatch (school, entrance, external).
lecturerRouter.get('/subjects', listSubjects);
lecturerRouter.post('/subjects', createSubject);
lecturerRouter.patch('/subjects/:id', updateSubject);

// Question photos. GET /media/:id is mounted publicly in main.ts.
lecturerRouter.post('/media', imageUpload.single('file'), uploadMedia);
lecturerRouter.delete('/media/:id', deleteMedia);

lecturerRouter.get('/exams', listExams);
lecturerRouter.post('/exams', createExam);
lecturerRouter.get('/exams/:id', getExamById);
lecturerRouter.patch('/exams/:id', updateExam);
lecturerRouter.delete('/exams/:id', deleteExam);

lecturerRouter.get('/questions/summary', getQuestionsSummary);
lecturerRouter.get('/questions', listQuestions);
lecturerRouter.get('/questions/template', downloadTemplate);
lecturerRouter.get('/questions/available', getAvailableQuestionCounts);
lecturerRouter.post('/questions', createQuestion);
lecturerRouter.post('/questions/bulk-approve', bulkApproveQuestions);
lecturerRouter.post('/questions/import', upload.single('file'), submitQuestionImportJob);
lecturerRouter.get('/questions/import/:jobId', getImportJobStatus);
lecturerRouter.get('/questions/:id', getQuestionById);
lecturerRouter.patch('/questions/:id', updateQuestion);
lecturerRouter.delete('/questions/:id', deleteQuestion);

lecturerRouter.post('/exams/:id/save-draft', saveExamDraft);
lecturerRouter.post('/exams/:id/submit', submitExamForModeration);
lecturerRouter.get('/moderation/submissions', getQuestionSubmissions);
lecturerRouter.post('/moderation/submissions/:id/review', reviewQuestionVersion);
lecturerRouter.get('/exams/:id/results', getExamResults);
lecturerRouter.get('/exams/:id/results/export/csv', exportExamResultsCsv);
lecturerRouter.get('/results/attempts/:attemptId/script', getLecturerAttemptScript);
