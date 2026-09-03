import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

const REQUIRED_PACKAGE_DOCS = Object.freeze([
  "docs/adr/0016-multi-model-context-domain-continuity.md",
  "docs/adr/0016a-official-chatgpt-transport-gate.md",
  "docs/adr/0017-provider-neutral-public-contract-surface.md",
  "docs/adr/0018-explicit-provider-installation.md",
  "docs/adr/0019-durable-context-state-lifecycle.md",
  "docs/adr/0020-bounded-hydration-privacy-boundary.md",
  "docs/adr/0021-external-read-query-tool-profile.md",
  "docs/adr/0022-provider-telemetry-attribution.md",
  "docs/adr/0023-handoff-context-compatibility.md",
]);

test("provider-neutral context contract is package-addressable with its governing ADRs", () => {
  assert.equal(packageJson.exports?.["./context-continuity"], "./src/context-continuity.mjs");
  for (const path of REQUIRED_PACKAGE_DOCS) {
    assert.equal(packageJson.files.includes(path), true, `${path} must ship with the package`);
  }
});

test("README exposes the context-continuity entry point without claiming ChatGPT Normal availability", () => {
  assert.match(readme, /aiopago\/context-continuity/);
  assert.match(readme, /does not make ordinary `ChatGPT Normal` available/i);
  assert.match(readme, /0016a-official-chatgpt-transport-gate\.md/);
  assert.match(readme, /configured `usage_pool` is also not evidence of commercial quota\/billing behavior/i);
});
