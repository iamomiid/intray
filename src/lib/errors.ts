export class AppError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}

export function badRequest(message: string, code = "bad_request"): AppError {
  return new AppError(400, code, message);
}

export function unauthorized(message: string, code = "unauthorized"): AppError {
  return new AppError(401, code, message);
}

export function forbidden(message: string, code = "forbidden"): AppError {
  return new AppError(403, code, message);
}

export function notFound(message: string, code = "not_found"): AppError {
  return new AppError(404, code, message);
}

export function conflict(message: string, code = "conflict"): AppError {
  return new AppError(409, code, message);
}

export function tooManyRequests(message: string, code = "too_many_requests"): AppError {
  return new AppError(429, code, message);
}
