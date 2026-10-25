export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const Errors = {
  invalidCredentials: () =>
    new AppError(401, 'AUTH_INVALID_CREDENTIALS', 'Wrong email or password. Please verify your credentials and try again.'),
  locked: (retryAfterSec: number) =>
    new AppError(423, 'AUTH_LOCKED', 'Account locked. Try again later.', { retryAfterSec }),
  tokenExpired: () => new AppError(401, 'AUTH_TOKEN_EXPIRED', 'Session expired.'),
  forbidden: (code = 'FORBIDDEN', message = 'You do not have access to this resource.', details?: Record<string, unknown>) =>
    new AppError(403, code, message, details),
  maintenance: () =>
    new AppError(503, 'MAINTENANCE', 'The system is under maintenance. Please try again later.'),
  serviceUnavailable: (code: string, message: string, details?: Record<string, unknown>) =>
    new AppError(503, code, message, details),
  notFound: (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found.`),
  badRequest: (code: string, message: string, details?: Record<string, unknown>) =>
    new AppError(400, code, message, details),
  conflict: (code: string, message: string, details?: Record<string, unknown>) =>
    new AppError(409, code, message, details),
  tooManyRequests: (retryAfterSec = 60, message = 'Too many requests. Please slow down.') =>
    new AppError(429, 'TOO_MANY_REQUESTS', message, { retryAfterSec }),
};
