import test from "node:test";
import assert from "node:assert/strict";
import {
  CHATGPT_TUI_INTENTS,
  CHATGPT_TUI_MODES,
  ChatgptTuiModeController,
  classifyChatgptTuiInput,
} from "../src/chatgpt-tui-mode.mjs";

test("classifies pure chat", () => {
  assert.equal(classifyChatgptTuiInput("Spiegami la linearizability").intent, CHATGPT_TUI_INTENTS.PURE_CHAT);
});

test("classifies local read and mixed context", () => {
  const read = classifyChatgptTuiInput("che branch siamo?");
  assert.equal(read.intent, CHATGPT_TUI_INTENTS.LOCAL_READ);
  assert.equal(read.mutation, false);

  const mixed = classifyChatgptTuiInput("guarda authority.ts e dimmi se vedi una race");
  assert.equal(mixed.intent, CHATGPT_TUI_INTENTS.MIXED);
  assert.equal(mixed.needs_local, true);
});

test("classifies explicit mutation", () => {
  const route = classifyChatgptTuiInput("correggi authority.ts e lancia i test");
  assert.equal(route.intent, CHATGPT_TUI_INTENTS.LOCAL_ACTION);
  assert.equal(route.mutation, true);
});

test("fails closed for pronoun-only action references", () => {
  const route = classifyChatgptTuiInput("ok fallo");
  assert.equal(route.intent, CHATGPT_TUI_INTENTS.AMBIGUOUS_ACTION);
  assert.equal(route.fail_closed, true);
});

test("controller toggles code/chat and never leaks chat input to code model", () => {
  const mode = new ChatgptTuiModeController();
  assert.equal(mode.status().mode, CHATGPT_TUI_MODES.CODE);
  assert.equal(mode.routeInput("hello").action, "continue");

  mode.toggle();
  assert.equal(mode.status().mode, CHATGPT_TUI_MODES.CHAT);
  const decision = mode.routeInput("hello");
  assert.equal(decision.action, "handled");
  assert.equal(decision.error.code, "CHATGPT_TUI_TRANSPORT_UNAVAILABLE");
});

test("attached transport allows chat routing while input remains extension-owned", () => {
  const mode = new ChatgptTuiModeController({ initialMode: CHATGPT_TUI_MODES.CHAT, transportAvailable: true });
  const decision = mode.routeInput("guarda il repo e spiegami lo stato");
  assert.equal(decision.action, "handled");
  assert.equal(decision.error, null);
  assert.equal(decision.route.needs_local, true);
});
