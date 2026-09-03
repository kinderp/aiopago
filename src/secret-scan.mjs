import { fail } from "./errors.mjs";

const SECRET_KEY = /(^|_)(api_?key|access_?token|refresh_?token|password|secret|credential)s?($|_)/i;
const SECRET_VALUE = /\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|Bearer\s+[A-Za-z0-9._-]{12,})\b/;

export function assertNoSecrets(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
    return value;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY.test(key) && child != null) fail("SECRET_SCAN_FAILED", `Sensitive field at ${path}.${key}`);
      assertNoSecrets(child, `${path}.${key}`);
    }
    return value;
  }
  if (typeof value === "string" && SECRET_VALUE.test(value)) fail("SECRET_SCAN_FAILED", `Secret-shaped value at ${path}`);
  return value;
}
