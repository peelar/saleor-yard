export class SandboxError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "SandboxError";
    this.code = code;
    this.details = details;
  }
}
export function toSandboxError(error: unknown): SandboxError {
  if (error instanceof SandboxError) {
    return error;
  }

  if (error instanceof Error) {
    return new SandboxError("unexpected_error", error.message);
  }

  return new SandboxError("unexpected_error", "An unexpected error occurred.", error);
}
