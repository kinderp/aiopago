import test from "node:test";
import assert from "node:assert/strict";
import { createGuardianExtension } from "../src/extension.mjs";

function extensionHarness() {
  const commands = new Map();
  const shortcuts = new Map();
  const events = new Map();
  const pi = {
    registerCommand(name, options) { commands.set(name, options); },
    registerShortcut(key, options) { shortcuts.set(key, options); },
    on(name, handler) { events.set(name, handler); },
  };
  const runner = {
    calibration: null,
    ledger: { read: () => ({ task_id: "TASK-TUI" }) },
    storage: { isAdmissionOpen: () => true },
    contextAdvisor: { reset() {} },
  };
  createGuardianExtension(runner)(pi);
  return { commands, shortcuts, events };
}

function fakeContext() {
  const notifications = [];
  const statuses = [];
  return {
    ctx: {
      ui: {
        notify(text, type) { notifications.push({ text, type }); },
        setStatus(key, value) { statuses.push({ key, value }); },
      },
    },
    notifications,
    statuses,
  };
}

test("registers a non-conflicting CODE/CHAT shortcut and chatmode command", () => {
  const h = extensionHarness();
  assert.ok(h.shortcuts.has("ctrl+alt+g"));
  assert.ok(h.commands.has("chatmode"));
});

test("Chat mode intercepts input before it can reach the Pi Code model when transport is unavailable", async () => {
  const h = extensionHarness();
  const ui = fakeContext();

  await h.shortcuts.get("ctrl+alt+g").handler(ui.ctx);
  const decision = h.events.get("input")({ text: "Spiegami la linearizability" }, ui.ctx);

  assert.deepEqual(decision, { action: "handled" });
  assert.ok(ui.statuses.some((entry) => String(entry.value).includes("CHAT")));
  assert.ok(ui.notifications.some((entry) => String(entry.text).includes("CHATGPT_TUI_TRANSPORT_UNAVAILABLE")));
});

test("toggling back to Code mode restores ordinary Pi input routing", async () => {
  const h = extensionHarness();
  const ui = fakeContext();

  await h.shortcuts.get("ctrl+alt+g").handler(ui.ctx);
  await h.shortcuts.get("ctrl+alt+g").handler(ui.ctx);
  const decision = h.events.get("input")({ text: "continue coding" }, ui.ctx);

  assert.deepEqual(decision, { action: "continue" });
  assert.ok(ui.statuses.some((entry) => String(entry.value).includes("CODE")));
});

test("ambiguous mutation reference fails closed in Chat mode", async () => {
  const h = extensionHarness();
  const ui = fakeContext();

  await h.commands.get("chatmode").handler("chat", ui.ctx);
  const decision = h.events.get("input")({ text: "ok fallo" }, ui.ctx);

  assert.deepEqual(decision, { action: "handled" });
  assert.ok(ui.notifications.some((entry) => String(entry.text).includes("CHATGPT_TUI_AMBIGUOUS_ACTION_REFERENCE")));
});
