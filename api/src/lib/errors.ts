/** Errors that carry an HTTP status, so a route can throw instead of threading replies. */

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message: string, code = "bad_request") =>
  new HttpError(400, code, message);
export const unauthorized = (message = "authentication required") =>
  new HttpError(401, "unauthorized", message);
export const forbidden = (message = "not permitted") => new HttpError(403, "forbidden", message);
export const notFound = (message = "not found") => new HttpError(404, "not_found", message);
export const conflict = (message: string, code = "conflict") => new HttpError(409, code, message);
export const tooManyRequests = (message: string) =>
  new HttpError(429, "too_many_requests", message);
