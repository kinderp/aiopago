import { GuardianError, invariant } from "./errors.mjs";

export const CHATGPT_TUI_MODES = Object.freeze({ CODE: "code", CHAT: "chat" });
export const CHATGPT_TUI_INTENTS = Object.freeze({
  PURE_CHAT: "pure-chat",
  LOCAL_READ: "local-read",
  LOCAL_ACTION: "local-action",
  MIXED: "mixed",
  AMBIGUOUS_ACTION: "ambiguous-action",
});

const AMBIGUOUS_ACTION_PATTERNS = [
  /^(?:ok[, ]*)?(?:fallo|falla|falli|falle|procedi(?:\s+cos[iì])?|fai\s+(?:quello|quella|cos[iì])|implementa\s+(?:quello|quella|cos[iì]))[.!? ]*$/iu,
  /^(?:ok[, ]*)?(?:do it|go ahead|implement that|apply that|make that change)[.!? ]*$/iu,
];

const LOCAL_READ_PATTERNS = [
  /\b(?:leggi|apri|mostra|guarda|controlla|ispeziona|cerca|trova|grep|branch|git status|git log|repository|repo|file|cartella|directory|test|tests|lint|spazio (?:libero|disco))\b/iu,
  /\b(?:read|open|show|inspect|search|find|branch|repository|repo|file|directory|tests?|lint|disk space)\b/iu,
];

const LOCAL_ACTION_PATTERNS = [
  /\b(?:modifica|correggi|scrivi|crea|aggiungi|rimuovi|cancella|rinomina|sposta|installa|committa|commit|push|merge|rebase|implementa|applica)\b/iu,
  /\b(?:modify|fix|write|create|add|remove|delete|rename|move|install|commit|push|merge|rebase|implement|apply)\b/iu,
];

const GENERAL_REASONING_PATTERNS = [
  /\b(?:spiega|dimmi|secondo te|perch[eé]|confronta|valuta|analizza|ragiona|consiglia)\b/iu,
  /\b(?:explain|why|compare|evaluate|analyse|analyze|reason|recommend)\b/iu,
];

function requiredText(value) {
  invariant(typeof value === "string" && value.trim().length > 0, "CHATGPT_TUI_INPUT_REQUIRED", "Chat mode input must be non-empty text");
  return value.trim();
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

export function classifyChatgptTuiInput(value) {
  const text = requiredText(value);
  if (matchesAny(text, AMBIGUOUS_ACTION_PATTERNS)) {
    return Object.freeze({
      intent: CHATGPT_TUI_INTENTS.AMBIGUOUS_ACTION,
      needs_local: true,
      mutation: true,
      fail_closed: true,
      reason: "ACTION_REFERENCE_DEPENDS_ON_UNOBSERVED_CHATGPT_OUTPUT",
    });
  }

  const hasRead = matchesAny(text, LOCAL_READ_PATTERNS);
  const hasAction = matchesAny(text, LOCAL_ACTION_PATTERNS);
  const hasReasoning = matchesAny(text, GENERAL_REASONING_PATTERNS);

  if (hasAction && hasReasoning) {
    return Object.freeze({
      intent: CHATGPT_TUI_INTENTS.MIXED,
      needs_local: true,
      mutation: true,
      fail_closed: false,
      reason: "LOCAL_MUTATION_PLUS_CHAT_REASONING",
    });
  }
  if (hasAction) {
    return Object.freeze({
      intent: CHATGPT_TUI_INTENTS.LOCAL_ACTION,
      needs_local: true,
      mutation: true,
      fail_closed: false,
      reason: "EXPLICIT_LOCAL_MUTATION",
    });
  }
  if (hasRead) {
    return Object.freeze({
      intent: hasReasoning ? CHATGPT_TUI_INTENTS.MIXED : CHATGPT_TUI_INTENTS.LOCAL_READ,
      needs_local: true,
      mutation: false,
      fail_closed: false,
      reason: hasReasoning ? "LOCAL_CONTEXT_PLUS_CHAT_REASONING" : "EXPLICIT_LOCAL_READ",
    });
  }
  return Object.freeze({
    intent: CHATGPT_TUI_INTENTS.PURE_CHAT,
    needs_local: false,
    mutation: false,
    fail_closed: false,
    reason: "NO_LOCAL_CONTEXT_REQUIRED",
  });
}

export class ChatgptTuiModeController {
  constructor({ initialMode = CHATGPT_TUI_MODES.CODE, transportAvailable = false } = {}) {
    invariant(Object.values(CHATGPT_TUI_MODES).includes(initialMode), "CHATGPT_TUI_MODE_INVALID", initialMode);
    this.mode = initialMode;
    this.transportAvailable = transportAvailable === true;
  }

  setMode(mode) {
    invariant(Object.values(CHATGPT_TUI_MODES).includes(mode), "CHATGPT_TUI_MODE_INVALID", mode);
    this.mode = mode;
    return this.status();
  }

  toggle() {
    this.mode = this.mode === CHATGPT_TUI_MODES.CODE ? CHATGPT_TUI_MODES.CHAT : CHATGPT_TUI_MODES.CODE;
    return this.status();
  }

  setTransportAvailable(value) {
    this.transportAvailable = value === true;
    return this.status();
  }

  status() {
    return Object.freeze({
      mode: this.mode,
      transport_available: this.transportAvailable,
      primary: this.mode === CHATGPT_TUI_MODES.CODE ? "pi-code-model" : "chatgpt-normal-sidecar",
    });
  }

  routeInput(text) {
    if (this.mode === CHATGPT_TUI_MODES.CODE) {
      return Object.freeze({ action: "continue", mode: this.mode, route: null });
    }

    const route = classifyChatgptTuiInput(text);
    if (route.fail_closed) {
      return Object.freeze({
        action: "handled",
        mode: this.mode,
        route,
        error: new GuardianError(
          "CHATGPT_TUI_AMBIGUOUS_ACTION_REFERENCE",
          "The requested local action depends on ChatGPT output that Aiopago cannot safely observe; restate the action explicitly",
        ),
      });
    }

    if (!this.transportAvailable) {
      return Object.freeze({
        action: "handled",
        mode: this.mode,
        route,
        error: new GuardianError(
          "CHATGPT_TUI_TRANSPORT_UNAVAILABLE",
          "Chat mode is active but no qualified interactive ChatGPT panel transport is attached; input was not sent to the Code model",
        ),
      });
    }

    return Object.freeze({ action: "handled", mode: this.mode, route, error: null });
  }
}
