export class GuardianError extends Error {
  constructor(code, message = code, details = undefined) {
    super(message);
    this.name = "GuardianError";
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message = code, details) {
  throw new GuardianError(code, message, details);
}

export function invariant(condition, code, message = code, details) {
  if (!condition) fail(code, message, details);
}
