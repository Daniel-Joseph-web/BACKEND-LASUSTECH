import { Router } from 'express';
import { requireAuth, requireRole } from '../auth/auth.middleware';
import { getDashboard } from './dashboard.controller';
import { bulkUsers, createUser, deleteUser, exportUsers, getUserCourses, importUsers, listUsers, resetPassword, setUserCourses, updateUser } from './users.controller';
import {
  createCollege, createCourse, createDepartment, createProgramme, deleteCollege, deleteCourse,
  deleteDepartment, deleteProgramme, getStructure, listCourses, updateCollege, updateCourse,
  updateDepartment, updateProgramme,
} from './structure.controller';
import { activateSession, closeSession, createSession, deleteSession, listSessions, sessionSummary, updateSession } from './sessions.controller';
import { exportAudit, listAudit, verifyAudit } from './audit.controller';
import { flushSessions, getSettings, updateSettings } from './settings.controller';
import { getAppeal, listAppeals, resolveAppeal, reviewAppeal } from './appeals.controller';
import { approveResults, getSittingResults, exportSittingResultsCsv, getAttemptScript, listResults, overrideScore, releaseResults, resolveResultFlags } from './results.controller';
import { broadsheet, exportIncidentEvents, incidentEvents, performance } from './reports.controller';
import {
  cancelSitting, closeSitting, createSitting, deleteSitting, listInvigilators, listSchedulableExams,
  listSchedule, listVenues, openSitting, regenerateAccessCode, updateSitting,
} from './schedule.controller';
import {
  addFlag, broadcast, clearFlags, exportProctorLog, extendAll, getLiveSitting, intervene,
  listLive, reassignSeat,
} from './live.controller';
import { createIncident, exportIncidents, listIncidents, updateIncident } from './incidents.controller';
import {
  listSupportTickets,
  getSupportTicket,
  replySupportTicket,
  updateSupportTicketStatus,
} from './support.controller';

export const adminRouter = Router();

// Everything below is ADMIN-only and never cached.
adminRouter.use(requireAuth, requireRole('ADMIN'), (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

adminRouter.get('/ping', (_req, res) => res.json({ data: 'pong' }));
adminRouter.get('/dashboard', getDashboard);

adminRouter.get('/users', listUsers);
adminRouter.get('/users/export', exportUsers);
adminRouter.post('/users', createUser);
adminRouter.post('/users/import', importUsers);
adminRouter.post('/users/bulk', bulkUsers);
adminRouter.patch('/users/:id', updateUser);
adminRouter.delete('/users/:id', deleteUser);
adminRouter.post('/users/:id/reset-password', resetPassword);
adminRouter.get('/users/:id/courses', getUserCourses);
adminRouter.put('/users/:id/courses', setUserCourses);

adminRouter.get('/structure', getStructure);
adminRouter.post('/colleges', createCollege);
adminRouter.patch('/colleges/:id', updateCollege);
adminRouter.delete('/colleges/:id', deleteCollege);
adminRouter.post('/departments', createDepartment);
adminRouter.patch('/departments/:id', updateDepartment);
adminRouter.delete('/departments/:id', deleteDepartment);
adminRouter.post('/programmes', createProgramme);
adminRouter.patch('/programmes/:id', updateProgramme);
adminRouter.delete('/programmes/:id', deleteProgramme);
adminRouter.get('/courses', listCourses);
adminRouter.post('/courses', createCourse);
adminRouter.patch('/courses/:id', updateCourse);
adminRouter.delete('/courses/:id', deleteCourse);

adminRouter.get('/sessions', listSessions);
adminRouter.post('/sessions', createSession);
adminRouter.patch('/sessions/:id', updateSession);
adminRouter.delete('/sessions/:id', deleteSession);
adminRouter.post('/sessions/:id/activate', activateSession);
adminRouter.post('/sessions/:id/close', closeSession);
adminRouter.get('/sessions/:id/summary', sessionSummary);

adminRouter.get('/audit', listAudit);
adminRouter.get('/audit/export', exportAudit);
adminRouter.get('/audit/verify', verifyAudit);

adminRouter.get('/settings', getSettings);
adminRouter.post('/settings/flush-sessions', flushSessions);
adminRouter.put('/settings/:group', updateSettings);

// ---- Exams, venues and sittings (schedule builder) ----
adminRouter.get('/exams', listSchedulableExams);
adminRouter.get('/venues', listVenues);
adminRouter.get('/invigilators', listInvigilators);
adminRouter.get('/schedule', listSchedule);
adminRouter.post('/schedule', createSitting);
adminRouter.patch('/schedule/:id', updateSitting);
adminRouter.delete('/schedule/:id', deleteSitting);
adminRouter.post('/schedule/:id/open', openSitting);
adminRouter.post('/schedule/:id/close', closeSitting);
adminRouter.post('/schedule/:id/cancel', cancelSitting);
adminRouter.post('/schedule/:id/access-code', regenerateAccessCode);

// ---- Live proctoring ----
adminRouter.get('/live', listLive);
adminRouter.get('/live/:id', getLiveSitting);
adminRouter.get('/live/:id/export', exportProctorLog);
adminRouter.post('/live/:id/intervene', intervene);
adminRouter.post('/live/:id/broadcast', broadcast);
adminRouter.post('/live/:id/extend-all', extendAll);
adminRouter.post('/live/:id/attempts/:attemptId/clear-flags', clearFlags);
adminRouter.post('/live/:id/attempts/:attemptId/flag', addFlag);
adminRouter.patch('/live/:id/attempts/:attemptId/seat', reassignSeat);

// ---- Results and appeals ----
adminRouter.get('/results', listResults);
adminRouter.get('/results/attempts/:attemptId/script', getAttemptScript);
adminRouter.get('/results/:id', getSittingResults);
adminRouter.get('/results/:id/export', exportSittingResultsCsv);
adminRouter.post('/results/:id/override', overrideScore);
adminRouter.post('/results/:id/approve', approveResults);
adminRouter.post('/results/:id/release', releaseResults);
adminRouter.post('/results/:id/resolve-flags', resolveResultFlags);

adminRouter.get('/appeals', listAppeals);
adminRouter.get('/appeals/:id', getAppeal);
adminRouter.patch('/appeals/:id/review', reviewAppeal);
adminRouter.patch('/appeals/:id/resolve', resolveAppeal);

// ---- Reports ----
adminRouter.get('/reports/broadsheet', broadsheet);
adminRouter.get('/reports/performance', performance);
adminRouter.get('/reports/incidents', incidentEvents);
adminRouter.get('/reports/incidents/export', exportIncidentEvents);

// ---- Incident dockets ----
adminRouter.get('/incidents', listIncidents);
adminRouter.get('/incidents/export', exportIncidents);
adminRouter.post('/incidents', createIncident);
adminRouter.patch('/incidents/:id', updateIncident);

// ---- Support Desk ----
adminRouter.get('/support', listSupportTickets);
adminRouter.get('/support/:id', getSupportTicket);
adminRouter.post('/support/:id/reply', replySupportTicket);
adminRouter.patch('/support/:id/status', updateSupportTicketStatus);
