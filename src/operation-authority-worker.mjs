// Protected P2 operation-authority worker. This entry is launched only by the
// native P1S Windows service over inherited anonymous pipes. It has no public
// listener, named pipe, eval/module-load request, or portable-storage fallback.
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { OPERATION_AUTHORITY_PROTOCOL, requireSecureOperationAuthority } from "./operation-authority.mjs";
import { requireSecureLatchAuthority } from "./latch-authority.mjs";
import { requireSecureHandoffAuthority } from "./handoff-reservation-authority.mjs";
import { requireSecureLifecycleAuthority } from "./lifecycle-binding-authority.mjs";
import { ProtectedSqliteOperationAuthority } from "./protected-operation-authority.mjs";
import { ToolOperationTracker } from "./safety.mjs";

async function operationAuthorityWorkerEntrypoint() {
const MAX_FRAME_BYTES = 262_144;
const MAX_REQUESTS = 128;
const SERVICE_NAME = /^AiopagoOperationAuthority(?:Test-[A-Za-z0-9-]{1,64})?$/;
const SERVICE_SID = /^S-1-5-80-(?:\d+-){4}\d+$/;
const CAPABILITY = /^[a-f0-9]{64}$/;

const lines = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
const iterator = lines[Symbol.asyncIterator]();
let capability = null;
let authority = null;
let requestCount = 0;
const trackers = new Map();

function output(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
async function readFrame() {
  const item = await iterator.next();
  if (item.done) throw Object.assign(new Error("PRIVATE_CHANNEL_CLOSED"), { code: "PRIVATE_CHANNEL_CLOSED" });
  if (Buffer.byteLength(item.value, "utf8") > MAX_FRAME_BYTES) throw Object.assign(new Error("FRAME_TOO_LARGE"), { code: "FRAME_TOO_LARGE" });
  let value;
  try { value = JSON.parse(item.value); } catch { throw Object.assign(new Error("FRAME_JSON_INVALID"), { code: "FRAME_JSON_INVALID" }); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error("FRAME_INVALID"), { code: "FRAME_INVALID" });
  return value;
}
function fail(code, message = code) { throw Object.assign(new Error(message), { code }); }
function identifier(value, code) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/.test(value)) fail(code);
  return value;
}
function tracker(taskId) {
  let value = trackers.get(taskId);
  if (!value) {
    authority.ensureLatch(taskId);
    value = new ToolOperationTracker(authority, taskId, {
      operationAuthority: requireSecureOperationAuthority(authority),
      latchAuthority: requireSecureLatchAuthority(authority),
    });
    trackers.set(taskId, value);
  }
  return value;
}
function requireServiceSid(systemDirectory, expectedSid) {
  if (process.platform !== "win32" || typeof systemDirectory !== "string" || !/^[A-Za-z]:\\Windows\\System32$/i.test(systemDirectory)) fail("WINDOWS_SERVICE_IDENTITY_REQUIRED");
  let groups;
  try {
    groups = execFileSync(join(systemDirectory, "whoami.exe"), ["/groups", "/fo", "csv", "/nh"], {
      encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: 5_000,
    });
  } catch { fail("WINDOWS_SERVICE_IDENTITY_UNAVAILABLE"); }
  if (!groups.includes(`\"${expectedSid}\"`)) fail("WINDOWS_SERVICE_IDENTITY_MISMATCH");
}
function operationResult(operation) {
  return operation ? {
    operation_id: operation.operation_id,
    task_id: operation.task_id,
    latch_generation: operation.latch_generation,
    profile: operation.profile,
    state: operation.state,
    outcome: operation.outcome,
    effect_reference: operation.effect_reference,
    admitted_at: operation.admitted_at,
    terminal_at: operation.terminal_at,
  } : null;
}
function latchResult(latch) {
  return latch ? {
    task_id: latch.task_id,
    state: latch.state,
    generation: latch.generation,
    reason: latch.reason,
    engaged_at: latch.engaged_at,
    engaged_by: latch.engaged_by,
    released_at: latch.released_at,
    released_by: latch.released_by,
    last_event_id: latch.last_event_id,
  } : null;
}
function handoffResult(reservation) {
  return reservation ? {
    ...reservation,
    reserved_plan_snapshot: reservation.reserved_plan_snapshot ?? null,
    expected_git_state: reservation.expected_git_state ?? null,
  } : null;
}
function lifecycleBindingResult(binding) {
  return binding ? {
    handoff_id: binding.handoff_id,
    replacement_session_id: binding.replacement_session_id,
    runner_instance_id: binding.runner_instance_id,
    session_binding_id: binding.session_binding_id,
    lifecycle_incarnation: binding.lifecycle_incarnation,
    status: binding.status,
    bound_at: binding.bound_at,
    bind_event_id: binding.bind_event_id,
    superseded_at: binding.superseded_at,
    superseded_reason: binding.superseded_reason,
    supersede_event_id: binding.supersede_event_id,
    event_data: binding.event_data,
    schema_version: binding.schema_version,
  } : null;
}

async function dispatch(frame, hello) {
  if (frame.version !== 1 || frame.protocol !== OPERATION_AUTHORITY_PROTOCOL || frame.capability !== capability) fail("PRIVATE_FRAME_BINDING_REJECTED");
  const requestId = identifier(frame.requestId, "REQUEST_ID_INVALID");
  const payload = frame.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("REQUEST_PAYLOAD_INVALID");
  requestCount += 1;
  if (requestCount > MAX_REQUESTS) fail("SESSION_REQUEST_LIMIT_EXCEEDED");
  let result;
  switch (frame.operationType) {
    case "OPERATION_ADMIT_TOOL": {
      const taskId = identifier(payload.taskId, "OPERATION_TASK_INVALID");
      const operationId = identifier(payload.operationId, "OPERATION_ID_INVALID");
      identifier(payload.toolName, "TOOL_NAME_INVALID");
      const expectedGeneration = payload.generation;
      if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) fail("OPERATION_GENERATION_INVALID");
      const latch = authority.getLatch(taskId) ?? authority.ensureLatch(taskId);
      if (latch.generation !== expectedGeneration) fail("LATCH_GENERATION_MISMATCH");
      tracker(taskId).admit(operationId, payload.toolName, payload.input ?? {});
      result = operationResult(authority.getOperation(operationId));
      break;
    }
    case "OPERATION_FINISH_TOOL": {
      const taskId = identifier(payload.taskId, "OPERATION_TASK_INVALID");
      const operationId = identifier(payload.operationId, "OPERATION_ID_INVALID");
      tracker(taskId).finish(operationId, payload.isError, payload.result, payload.interrupted === true);
      result = operationResult(authority.getOperation(operationId));
      break;
    }
    case "OPERATION_MARK_UNKNOWN": {
      const taskId = identifier(payload.taskId, "OPERATION_TASK_INVALID");
      const operationId = identifier(payload.operationId, "OPERATION_ID_INVALID");
      tracker(taskId).unknown(operationId);
      result = operationResult(authority.getOperation(operationId));
      break;
    }
    case "LATCH_ENSURE":
      result = latchResult(authority.ensureLatch(identifier(payload.taskId, "LATCH_TASK_INVALID")));
      break;
    case "LATCH_GET":
      result = latchResult(authority.getLatch(identifier(payload.taskId, "LATCH_TASK_INVALID")));
      break;
    case "LATCH_CLAIM_HUMAN_TAKEOVER": {
      const request = authority.requestLatchClaim(requestId, {
        taskId: payload.taskId, reason: "HUMAN_TAKEOVER", actor: payload.actor, expected: payload.expected ?? null,
      });
      result = { ...request, latch: latchResult(request.latch) };
      break;
    }
    case "LATCH_CLAIM_SAFEPOINT": {
      if (payload.reason === "HUMAN_TAKEOVER") fail("LATCH_SAFEPOINT_REASON_INVALID");
      const request = authority.requestLatchClaim(requestId, {
        taskId: payload.taskId, reason: payload.reason, actor: payload.actor, expected: payload.expected ?? null,
      });
      result = { ...request, latch: latchResult(request.latch) };
      break;
    }
    case "LATCH_ASSERT":
      result = latchResult(authority.assertLatchIdentity(payload.taskId, payload.expected, { allowHumanTakeover: payload.allowHumanTakeover === true }));
      break;
    case "HANDOFF_RESERVE": {
      const reserved = authority.requestHandoffReservation(requestId, {
        projection: payload.projection,
        expectedLatch: payload.expectedLatch,
        expectedLatest: payload.expectedLatest ?? null,
      });
      result = {
        ...reserved,
        reservation: handoffResult(authority.getHandoffReservation(payload.projection?.handoff_id)),
      };
      break;
    }
    case "HANDOFF_GET":
      result = handoffResult(authority.getHandoffReservation(payload.handoffId));
      break;
    case "HANDOFF_LATEST_TASK":
      result = handoffResult(authority.latestHandoffReservationForTask(payload.taskId));
      break;
    case "ACTIVE_SOURCE_GET":
      result = authority.getActiveSource(payload.sourceSessionId);
      break;
    case "LIFECYCLE_BIND_CREATE": {
      const created = authority.requestLifecycleBindingCreate(requestId, { binding: payload.binding });
      result = { ...created, binding: lifecycleBindingResult(created.binding) };
      break;
    }
    case "LIFECYCLE_BIND_GET":
      result = lifecycleBindingResult(authority.getLifecycleBinding(payload.handoffId));
      break;
    case "LIFECYCLE_BIND_GET_SESSION":
      result = lifecycleBindingResult(authority.getLifecycleBindingBySession(payload.sessionId));
      break;
    case "LIFECYCLE_BIND_TRANSITION": {
      const transitioned = authority.requestLifecycleBindingTransition(requestId, {
        expected: payload.expected, nextStatus: payload.nextStatus, reason: payload.reason,
      });
      result = { ...transitioned, binding: lifecycleBindingResult(transitioned.binding) };
      break;
    }
    case "LIFECYCLE_BIND_EVENTS":
      result = authority.lifecycleBindingEvents(payload.handoffId);
      break;
    case "OPERATION_RETRY_ADMISSION": {
      result = authority.admitOperation({
        operationId: payload.operationId, taskId: payload.taskId,
        generation: payload.generation, profile: payload.profile,
      });
      result = { ...result, operation: operationResult(result.operation) };
      break;
    }
    case "OPERATION_RETRY_TERMINAL": {
      result = authority.finishOperation(payload.operationId, payload.outcome, payload.effectReference ?? null);
      result = { ...result, operation: operationResult(result.operation) };
      break;
    }
    case "OPERATION_GET":
      result = operationResult(authority.getOperation(payload.operationId));
      break;
    case "OPERATION_LIST_TASK":
      result = authority.operationsForTask(payload.taskId).map(operationResult);
      break;
    case "TEST_CRASH_BEFORE_TERMINAL_COMMIT":
      if (hello.testScope !== true || !hello.serviceName.startsWith("AiopagoOperationAuthorityTest-")) fail("TEST_OPERATION_FORBIDDEN");
      authority.crashBeforeTerminalCommitForPhysicalTest(payload.operationId, payload.outcome, payload.effectReference ?? null);
      fail("CRASH_SEAM_RETURNED");
      break;
    case "TEST_CRASH_BEFORE_LATCH_COMMIT":
      if (hello.testScope !== true || !hello.serviceName.startsWith("AiopagoOperationAuthorityTest-")) fail("TEST_OPERATION_FORBIDDEN");
      authority.crashBeforeLatchCommitForPhysicalTest(requestId, {
        taskId: payload.taskId, reason: payload.reason, actor: payload.actor, expected: payload.expected ?? null,
      });
      fail("CRASH_SEAM_RETURNED");
      break;
    case "TEST_CRASH_BEFORE_HANDOFF_COMMIT":
      if (hello.testScope !== true || !hello.serviceName.startsWith("AiopagoOperationAuthorityTest-")) fail("TEST_OPERATION_FORBIDDEN");
      authority.crashBeforeHandoffCommitForPhysicalTest(requestId, {
        projection: payload.projection, expectedLatch: payload.expectedLatch, expectedLatest: payload.expectedLatest ?? null,
      });
      fail("CRASH_SEAM_RETURNED");
      break;
    case "TEST_CRASH_BEFORE_LIFECYCLE_COMMIT":
      if (hello.testScope !== true || !hello.serviceName.startsWith("AiopagoOperationAuthorityTest-")) fail("TEST_OPERATION_FORBIDDEN");
      authority.crashBeforeLifecycleTransitionCommitForPhysicalTest(requestId, {
        expected: payload.expected, nextStatus: payload.nextStatus, reason: payload.reason,
      });
      fail("CRASH_SEAM_RETURNED");
      break;
    case "TEST_AUTHORITY_TIMEOUT":
      if (hello.testScope !== true || !hello.serviceName.startsWith("AiopagoOperationAuthorityTest-")) fail("TEST_OPERATION_FORBIDDEN");
      await new Promise(() => {});
      break;
    default:
      fail("OPERATION_TYPE_INVALID");
  }
  return { version: 1, protocol: OPERATION_AUTHORITY_PROTOCOL, requestId, operationType: "OPERATION_RESULT", ok: true, result };
}

try {
  const hello = await readFrame();
  if (hello.version !== 1 || hello.protocol !== OPERATION_AUTHORITY_PROTOCOL || hello.operationType !== "SESSION_BIND"
    || !CAPABILITY.test(hello.capability ?? "") || hello.p1Pid !== process.ppid || hello.p2Pid !== process.pid
    || !SERVICE_NAME.test(hello.serviceName ?? "") || !SERVICE_SID.test(hello.serviceSid ?? "")
    || !/^[a-f0-9]{64}$/.test(hello.identityFingerprint ?? "")
    || typeof hello.canonicalPath !== "string" || typeof hello.allowInitialize !== "boolean") fail("SESSION_BIND_REJECTED");
  requireServiceSid(hello.systemDirectory, hello.serviceSid);
  capability = hello.capability;
  authority = new ProtectedSqliteOperationAuthority(hello.canonicalPath, { allowInitialize: hello.allowInitialize });
  requireSecureOperationAuthority(authority);
  requireSecureLatchAuthority(authority);
  requireSecureHandoffAuthority(authority);
  requireSecureLifecycleAuthority(authority);
  output({ version: 1, protocol: OPERATION_AUTHORITY_PROTOCOL, operationType: "SESSION_READY", capability, p2Pid: process.pid, authority: authority.status() });

  while (true) {
    const frame = await readFrame();
    if (frame.operationType === "SESSION_END") {
      if (frame.version !== 1 || frame.protocol !== OPERATION_AUTHORITY_PROTOCOL || frame.capability !== capability) fail("PRIVATE_FRAME_BINDING_REJECTED");
      output({ version: 1, protocol: OPERATION_AUTHORITY_PROTOCOL, operationType: "SESSION_COMPLETE", requestCount, authority: authority.status() });
      break;
    }
    try { output(await dispatch(frame, hello)); }
    catch (error) {
      output({ version: 1, protocol: OPERATION_AUTHORITY_PROTOCOL, requestId: frame.requestId ?? null, operationType: "OPERATION_RESULT", ok: false, error: { code: error?.code ?? "OPERATION_AUTHORITY_FAILED", message: error?.message ?? String(error) } });
    }
  }
  authority.close();
  lines.close();
} catch (error) {
  try { authority?.close(); } catch {}
  process.stderr.write(`operation-authority-worker: ${error?.code ?? "FAILED"}: ${error?.message ?? String(error)}\n`);
  process.exitCode = 2;
}
}

// Activation is not authority: P0 can copy these readable bytes and set this
// flag, but its token lacks the required service SID and protected DB access.
// P1S strips ambient injection variables and sets only this worker role marker;
// the actual authority remains the OS token plus private inherited channel.
if (process.env.AIOPAGO_PROTECTED_OPERATION_WORKER === "1") await operationAuthorityWorkerEntrypoint();
