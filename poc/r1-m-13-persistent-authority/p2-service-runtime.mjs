// P1S-launched privileged test runtime for the distinct-identity PoC.
// Authority is the inherited private channel and dynamic capability, never argv/env.
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
const iterator = lines[Symbol.asyncIterator]();
const read = async () => {
  const item = await iterator.next();
  if (item.done) throw new Error("PRIVATE_CHANNEL_CLOSED");
  if (Buffer.byteLength(item.value) > 8192) throw new Error("FRAME_TOO_LARGE");
  return JSON.parse(item.value);
};
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

try {
  const hello = await read();
  if (hello?.version !== 1 || hello?.operationType !== "HELLO"
      || !/^[a-f0-9]{64}$/.test(hello?.capability ?? "")
      || hello?.payload?.p1Pid !== process.ppid || hello?.payload?.p2Pid !== process.pid
      || hello?.payload?.semanticOperation !== "POC_OPERATION_TERMINAL") {
    throw new Error("HELLO_REJECTED");
  }
  const request = {
    version: 1,
    requestId: hello.payload.operationId,
    operationType: hello.payload.semanticOperation,
    capability: hello.capability,
    payload: { value: hello.payload.payload },
  };
  write(request);
  const first = await read();
  if (first?.operationType !== "MUTATION_RESULT" || first?.payload?.code !== "MUTATION_ACCEPTED") {
    throw new Error("AUTHORIZED_MUTATION_REJECTED");
  }
  write(request);
  const duplicate = await read();
  if (duplicate?.payload?.code !== "IDEMPOTENT_RECORDED_RESULT") throw new Error("IDEMPOTENCY_FAILED");
  write({ ...request, payload: { value: `${hello.payload.payload}-changed` } });
  const conflict = await read();
  if (conflict?.payload?.code !== "REQUEST_ID_CONFLICT") throw new Error("CONFLICT_FAILED");
  lines.close();
} catch (error) {
  process.stderr.write(`p2-service-runtime: ${error?.message ?? String(error)}\n`);
  process.exitCode = 2;
}
