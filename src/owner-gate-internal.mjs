import { canonicalJson, strictJsonClone } from "./canonical.mjs";
import { invariant } from "./errors.mjs";

// This is the single definition of command-token whitespace. It deliberately
// preserves JavaScript /\s/ semantics used by the original canonicalizer.
const COMMAND_TOKEN_WHITESPACE = /\s/u;

export function isCommandTokenWhitespace(character) {
  return character !== undefined && COMMAND_TOKEN_WHITESPACE.test(character);
}

export function commandTokens(value) {
  if (typeof value !== "string") return null;
  const tokens = [];
  let start = -1;
  for (let index = 0; index <= value.length; index += 1) {
    if (index < value.length && !isCommandTokenWhitespace(value[index])) {
      if (start === -1) start = index;
    } else if (start !== -1) {
      tokens.push(value.slice(start, index));
      start = -1;
    }
  }
  return tokens;
}

export function assertExactSatisfiedOwnerGateTransition(base, candidate, actor, now) {
  const code = "OWNER_GATE_TRANSITION_INVALID";
  let expected;
  try {
    expected = strictJsonClone(base, { code, field: "Base owner-gate transition" });
    expected.owner_gate.status = "SATISFIED";
    expected.owner_gate.satisfied_at = now;
    expected.owner_gate.satisfied_by = actor;
    expected.plan_revision_id = expected.owner_gate.satisfied_plan_revision_id;
    expected.status = "IN_PROGRESS";
    expected.updated_at = now;
    expected.current_item = expected.owner_gate.item_id;
    expected.next_item = expected.owner_gate.satisfied_next_item ?? null;
    expected.next_step = expected.owner_gate.satisfied_next_step;
    const protectedItem = expected.task_items.find((item) => item.task_item_id === expected.owner_gate.item_id);
    invariant(protectedItem, code, "The protected TaskItem is absent from the expected owner-gate transition");
    protectedItem.status = "IN_PROGRESS";
    protectedItem.last_updated_at = now;
    protectedItem.last_updated_by = actor;

    strictJsonClone(candidate, { code, field: "Candidate owner-gate transition", clone: false });
  } catch (error) {
    if (error?.code === code) throw error;
    invariant(false, code, "The owner-gate transition is outside the strict JSON domain");
  }
  invariant(canonicalJson(candidate) === canonicalJson(expected), code, "Owner-gate satisfaction contains an unauthorized transition delta");
  return candidate;
}
