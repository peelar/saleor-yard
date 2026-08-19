export class YardError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "YardError";
    this.code = code;
    this.details = details;
  }
}
export function toYardError(error: unknown): YardError {
  if (error instanceof YardError) {
    return error;
  }

  if (error instanceof Error) {
    return new YardError("unexpected_error", error.message);
  }

  return new YardError("unexpected_error", "An unexpected error occurred.", error);
}
