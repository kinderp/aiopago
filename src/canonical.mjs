import { createHash, randomUUID } from "node:crypto";

const MAX_JSON_DEPTH = 128;
const MAX_JSON_NODES = 100_000;

export function strictJsonClone(value, { code = "STRICT_JSON_DOMAIN_INVALID", field = "value", clone = true } = {}) {
  const ancestors = new Set();
  let nodes = 0;

  const fail = (message) => {
    const error = new TypeError(`${field} is outside the strict JSON domain: ${message}`);
    error.code = code;
    throw error;
  };

  const visit = (current, path, depth) => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES) fail(`more than ${MAX_JSON_NODES} values`);
    if (depth > MAX_JSON_DEPTH) fail(`nesting exceeds ${MAX_JSON_DEPTH} at ${path}`);
    if (current === null || typeof current === "boolean" || typeof current === "string") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) fail(`non-finite number at ${path}`);
      return Object.is(current, -0) ? 0 : current;
    }
    if (typeof current !== "object") fail(`${typeof current} at ${path}`);
    if (ancestors.has(current)) fail(`cycle at ${path}`);

    const prototype = Object.getPrototypeOf(current);
    if (Array.isArray(current)) {
      if (prototype !== Array.prototype) fail(`array with a custom prototype at ${path}`);
      if (current.length > MAX_JSON_NODES) fail(`array is too large at ${path}`);
      const keys = Reflect.ownKeys(current);
      if (keys.some((key) => typeof key === "symbol")) fail(`symbol-keyed array property at ${path}`);
      const expected = new Set(["length", ...Array.from({ length: current.length }, (_, index) => String(index))]);
      if (keys.some((key) => !expected.has(key)) || keys.length !== expected.size) fail(`sparse array or extra array property at ${path}`);
      ancestors.add(current);
      const result = clone ? [] : current;
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(`accessor or hidden array element at ${path}[${index}]`);
        const child = visit(descriptor.value, `${path}[${index}]`, depth + 1);
        if (clone) result.push(child);
      }
      ancestors.delete(current);
      return result;
    }

    if (prototype !== Object.prototype && prototype !== null) fail(`non-plain object at ${path}`);
    const keys = Reflect.ownKeys(current);
    if (keys.some((key) => typeof key === "symbol")) fail(`symbol-keyed property at ${path}`);
    ancestors.add(current);
    const result = clone ? {} : current;
    for (const key of keys.sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(`accessor or hidden property at ${path}.${key}`);
      const child = visit(descriptor.value, `${path}.${key}`, depth + 1);
      if (clone) Object.defineProperty(result, key, { value: child, enumerable: true, writable: true, configurable: true });
    }
    ancestors.delete(current);
    return result;
  };

  return visit(value, "$", 0);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  if (value === undefined) throw new TypeError("undefined is not canonical JSON");
  return JSON.stringify(value);
}

export function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function digestObject(value) {
  return sha256(Buffer.from(canonicalJson(value), "utf8"));
}

export function stableId(prefix, ...parts) {
  return `${prefix}-${createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 24)}`;
}

export function opaqueId(prefix) {
  return `${prefix}-${randomUUID()}`;
}

export function utcNow() {
  return new Date().toISOString();
}

export function jsonClone(value) {
  return structuredClone(value);
}
