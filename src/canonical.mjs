import { createHash, randomUUID } from "node:crypto";

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
