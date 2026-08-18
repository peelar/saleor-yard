export class FactoryError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "FactoryError";
    this.code = code;
    this.details = details;
  }
}
export function toFactoryError(error: unknown): FactoryError {
  if (error instanceof FactoryError) {
    return error;
  }

  if (error instanceof Error) {
    return new FactoryError("unexpected_error", error.message);
  }

  return new FactoryError("unexpected_error", "An unexpected error occurred.", error);
}
