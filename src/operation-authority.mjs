import { invariant } from "./errors.mjs";

export const OPERATION_AUTHORITY_MODES = Object.freeze({
  SECURE: "SECURE",
  PORTABLE: "PORTABLE",
});

export const PREVIOUS_OPERATION_AUTHORITY_SCHEMA = "aiopago.operation-authority/1.0.0";
export const LATCH_OPERATION_AUTHORITY_SCHEMA = "aiopago.operation-authority/1.1.0";
export const HANDOFF_OPERATION_AUTHORITY_SCHEMA = "aiopago.operation-authority/1.2.0";
export const OPERATION_AUTHORITY_SCHEMA = "aiopago.operation-authority/1.3.0";
export const OPERATION_AUTHORITY_PROTOCOL = "aiopago.operation-authority-protocol/4";

const PROFILES = new Set(["READ_ONLY", "LOCAL_ATOMIC_MUTATION", "SHELL_ATOMIC_OPERATION"]);
const OUTCOMES = new Set(["KNOWN_SUCCESS", "KNOWN_FAILURE", "UNKNOWN"]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const EFFECT_REFERENCE = /^(?:file|shell):[^\r\n]{1,2048}$/;

export const SECURE_OPERATION_AUTHORITY_LABEL = Object.freeze({
  mode: OPERATION_AUTHORITY_MODES.SECURE,
  canonical: true,
  isolation: "OS_PROTECTED_DISTINCT_IDENTITY",
  r1_m_13_operation_isolation: true,
});
const PORTABLE_LABEL = Object.freeze({
  mode: OPERATION_AUTHORITY_MODES.PORTABLE,
  canonical: false,
  isolation: "ORDINARY_USER_OWNED",
  r1_m_13_operation_isolation: false,
});

export function operationIdentifier(value, code, field) {
  invariant(typeof value === "string" && IDENTIFIER.test(value), code, `${field} is invalid`);
  return value;
}

export function validateOperationAdmission(request) {
  invariant(request && typeof request === "object" && !Array.isArray(request), "OPERATION_ADMISSION_INVALID");
  const operationId = operationIdentifier(request.operationId, "OPERATION_ID_INVALID", "operationId");
  const taskId = operationIdentifier(request.taskId, "OPERATION_TASK_INVALID", "taskId");
  invariant(Number.isSafeInteger(request.generation) && request.generation >= 0, "OPERATION_GENERATION_INVALID");
  invariant(PROFILES.has(request.profile), "OPERATION_PROFILE_INVALID");
  return Object.freeze({ operationId, taskId, generation: request.generation, profile: request.profile });
}

export function validateOperationTerminal(operationId, outcome, effectReference) {
  operationIdentifier(operationId, "OPERATION_ID_INVALID", "operationId");
  invariant(OUTCOMES.has(outcome), "OPERATION_OUTCOME_INVALID");
  invariant(effectReference === null || (typeof effectReference === "string" && EFFECT_REFERENCE.test(effectReference)), "OPERATION_EFFECT_REFERENCE_INVALID");
  if (outcome !== "KNOWN_SUCCESS") invariant(effectReference === null, "OPERATION_EFFECT_REFERENCE_INVALID", "Only known success may carry effect evidence");
  return Object.freeze({ operationId, outcome, effectReference });
}

export function detachedOperation(row) { return row ? Object.freeze({ ...row }) : null; }

export class PortableOperationAuthority {
  constructor(storage) {
    invariant(storage && typeof storage.admitOperation === "function"
      && typeof storage.finishOperation === "function"
      && typeof storage.operationsForTask === "function", "PORTABLE_OPERATION_AUTHORITY_INVALID");
    this.storage = storage;
    this.security = PORTABLE_LABEL;
  }

  admitOperation(request) {
    const value = validateOperationAdmission(request);
    this.storage.admitOperation(value);
    return detachedOperation(this.storage.operationsForTask(value.taskId).find((row) => row.operation_id === value.operationId));
  }

  finishOperation(operationId, outcome, effectReference = null) {
    const value = validateOperationTerminal(operationId, outcome, effectReference);
    this.storage.finishOperation(value.operationId, value.outcome, value.effectReference);
    return null;
  }

  operationsForTask(taskId) {
    operationIdentifier(taskId, "OPERATION_TASK_INVALID", "taskId");
    return Object.freeze(this.storage.operationsForTask(taskId).map(detachedOperation));
  }

  getOperation(operationId) {
    operationIdentifier(operationId, "OPERATION_ID_INVALID", "operationId");
    return null;
  }

  close() {}
}

export function portableOperationAuthority(storage) { return new PortableOperationAuthority(storage); }

export function requireSecureOperationAuthority(authority) {
  invariant(authority?.security?.mode === OPERATION_AUTHORITY_MODES.SECURE
    && authority.security.canonical === true
    && authority.security.r1_m_13_operation_isolation === true,
  "SECURE_OPERATION_AUTHORITY_REQUIRED", "Secure execution cannot use or fall back to portable operation state");
  return authority;
}
