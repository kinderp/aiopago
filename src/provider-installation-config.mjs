import { invariant } from "./errors.mjs";

export const PROVIDER_INSTALLATION_CONFIG_SCHEMA_VERSION = "0.1.0";
export const PROVIDER_INSTALLATION_MODES = Object.freeze([
  "production",
  "experimental-nonproduction",
]);

function record(value, code, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), code, `${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  invariant(prototype === Object.prototype || prototype === null, code, `${label} must be a plain object`);
  invariant(Object.getOwnPropertySymbols(value).length === 0, code, `${label} must not contain symbol keys`);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    invariant(Object.prototype.hasOwnProperty.call(descriptor, "value"), code, `${label} must contain data properties only`);
  }
  return value;
}

function exactKeys(value, allowed, code) {
  for (const key of Object.keys(value)) invariant(allowed.includes(key), code, key);
}

function requiredString(value, code, label) {
  invariant(typeof value === "string" && value.trim().length > 0, code, `${label} must be a non-empty string`);
  return value.trim();
}

function normalizeEntry(input, index) {
  const entry = record(input, "PROVIDER_INSTALLATION_ENTRY_INVALID", `adapters[${index}]`);
  exactKeys(entry, ["adapter_id", "mode"], "PROVIDER_INSTALLATION_ENTRY_FIELD_UNKNOWN");
  const adapterId = requiredString(entry.adapter_id, "PROVIDER_INSTALLATION_ADAPTER_ID_REQUIRED", `adapters[${index}].adapter_id`);
  const mode = requiredString(entry.mode, "PROVIDER_INSTALLATION_MODE_REQUIRED", `adapters[${index}].mode`);
  invariant(PROVIDER_INSTALLATION_MODES.includes(mode), "PROVIDER_INSTALLATION_MODE_INVALID", mode);
  return Object.freeze({ adapter_id: adapterId, mode });
}

export function defineProviderInstallationConfig(input) {
  const config = record(input, "PROVIDER_INSTALLATION_CONFIG_INVALID", "provider installation config");
  exactKeys(config, ["schema_version", "adapters"], "PROVIDER_INSTALLATION_CONFIG_FIELD_UNKNOWN");
  if (config.schema_version !== undefined) {
    invariant(config.schema_version === PROVIDER_INSTALLATION_CONFIG_SCHEMA_VERSION, "PROVIDER_INSTALLATION_CONFIG_SCHEMA_UNSUPPORTED", String(config.schema_version));
  }
  invariant(Array.isArray(config.adapters), "PROVIDER_INSTALLATION_ADAPTERS_REQUIRED", "adapters must be an array");

  const seen = new Set();
  const adapters = config.adapters.map((entry, index) => {
    const normalized = normalizeEntry(entry, index);
    invariant(!seen.has(normalized.adapter_id), "PROVIDER_INSTALLATION_ADAPTER_DUPLICATE", normalized.adapter_id);
    seen.add(normalized.adapter_id);
    return normalized;
  });

  return Object.freeze({
    schema_version: PROVIDER_INSTALLATION_CONFIG_SCHEMA_VERSION,
    adapters: Object.freeze(adapters),
  });
}
