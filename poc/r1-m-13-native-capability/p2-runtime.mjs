// R1-M-13 bounded P2 runtime. Readable JavaScript is intentional: authority is
// the inherited private channel plus dynamic capability, not this function name.
import { createInterface } from "node:readline";

const VERSION = 1;
const MAX_FRAME_BYTES = 8192;

function boundedMessage(message) {
  const encoded = JSON.stringify(message);
  if (Buffer.byteLength(encoded) + 1 > MAX_FRAME_BYTES) throw new Error("FRAME_TOO_LARGE");
  return `${encoded}\n`;
}

function protocol() {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  const iterator = lines[Symbol.asyncIterator]();
  return {
    async read() {
      const item = await iterator.next();
      if (item.done) throw new Error("PRIVATE_CHANNEL_UNAVAILABLE");
      if (Buffer.byteLength(item.value) > MAX_FRAME_BYTES) throw new Error("FRAME_TOO_LARGE");
      const value = JSON.parse(item.value);
      if (value?.version !== VERSION || typeof value.requestId !== "string"
        || typeof value.operationType !== "string" || value.payload === null
        || typeof value.payload !== "object" || Array.isArray(value.payload)) {
        throw new Error("FRAME_CONTRACT_INVALID");
      }
      return value;
    },
    write(message) { process.stdout.write(boundedMessage(message)); },
    close() { lines.close(); },
  };
}

export async function runPrivilegedTestRuntime() {
  const channel = protocol();
  const hello = await channel.read();
  if (hello.operationType !== "HELLO" || typeof hello.capability !== "string"
    || !/^[a-f0-9]{64}$/.test(hello.capability)
    || hello.payload?.p2Pid !== process.pid || hello.payload?.p1Pid !== process.ppid) {
    throw new Error("HELLO_REJECTED");
  }
  const capability = hello.capability;
  const sessionId = hello.payload.sessionId;
  channel.write({
    version: VERSION,
    requestId: "bind-1",
    operationType: "SESSION_BIND",
    capability,
    payload: { sessionId, p2Pid: process.pid, p2ParentPid: process.ppid },
  });
  const bound = await channel.read();
  if (bound.operationType !== "MUTATION_RESULT" || bound.payload?.code !== "SESSION_BOUND") throw new Error("SESSION_BIND_FAILED");

  const request = {
    version: VERSION,
    requestId: "mutation-1",
    operationType: "AUTHORIZE_MUTATION",
    capability,
    payload: {
      mutationType: "POC_OPERATION_TERMINAL",
      operationId: "OP-POC-AUTHORIZED",
      repositoryId: "REPO-POC-FIXED",
      taskId: "TASK-POC-FIXED",
      planRevision: "PLAN-POC-1",
      planDigest: "sha256:poc-fixed-digest",
      sessionId,
      runnerLifecycle: "ACTIVE",
      takeoverGeneration: 0,
    },
  };
  channel.write(request);
  const accepted = await channel.read();
  if (accepted.payload?.code !== "MUTATION_ACCEPTED" || accepted.payload?.acceptedMutationCount !== 1) throw new Error("AUTHORIZED_MUTATION_FAILED");

  channel.write(request);
  const duplicate = await channel.read();
  if (duplicate.payload?.code !== "DUPLICATE_IDEMPOTENT" || duplicate.payload?.acceptedMutationCount !== 1) throw new Error("DUPLICATE_NOT_IDEMPOTENT");

  channel.write({ ...request, payload: { ...request.payload, operationId: "OP-POC-CONFLICT" } });
  const conflict = await channel.read();
  if (conflict.payload?.code !== "REQUEST_ID_CONFLICT" || conflict.payload?.acceptedMutationCount !== 1) throw new Error("REQUEST_CONFLICT_NOT_REJECTED");

  channel.write({ ...request, requestId: "fake-capability-1", capability: "00".repeat(32) });
  const fake = await channel.read();
  if (fake.payload?.code !== "CAPABILITY_REJECTED" || fake.payload?.acceptedMutationCount !== 1) throw new Error("FAKE_CAPABILITY_NOT_REJECTED");

  channel.write({
    version: VERSION,
    requestId: "shutdown-1",
    operationType: "SHUTDOWN",
    capability,
    payload: { reason: "POC_COMPLETE" },
  });
  const closed = await channel.read();
  if (closed.payload?.code !== "SHUTDOWN") throw new Error("SHUTDOWN_FAILED");
  channel.close();
}

if (import.meta.main) {
  try {
    await runPrivilegedTestRuntime();
  } catch (error) {
    // No capability value is included in diagnostics.
    process.stderr.write(`p2: ${error?.message ?? String(error)}\n`);
    process.exitCode = 2;
  }
}
