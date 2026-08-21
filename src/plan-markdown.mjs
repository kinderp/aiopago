import { invariant } from "./errors.mjs";
import { LEGACY_TASK_LEDGER_SCHEMA, TASK_LEDGER_SCHEMA } from "./plan-store.mjs";

const SUPPORTED_LEDGER_SCHEMAS = new Set([TASK_LEDGER_SCHEMA, LEGACY_TASK_LEDGER_SCHEMA]);
const METADATA_HEADERS = Object.freeze([
  { field: "plan_revision_id", pattern: /^\*\*Current revision:\*\*[ \t]*`([^`\r\n]+)`[ \t]*$/ },
  { field: "requirements_version", pattern: /^\*\*Requirements version:\*\*[ \t]*`([^`\r\n]+)`[ \t]*$/ },
  { field: "updated_at", pattern: /^\*\*Updated:\*\*[ \t]*(\S(?:.*?\S)?)[ \t]*$/ },
]);

function markdownLines(text) {
  const lines = [];
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf("\n", start);
    const next = newline === -1 ? text.length : newline + 1;
    let end = newline === -1 ? text.length : newline;
    if (end > start && text[end - 1] === "\r") end -= 1;
    lines.push({ start, end, next, content: text.slice(start, end) });
    if (newline === -1) break;
    start = next;
  }
  return lines;
}

export function analyzeLedgerMetadata(observed, { allowSchemalessCompact = false } = {}) {
  if (allowSchemalessCompact && observed.schemaHeaderCount === 0 && observed.ledgerSchema === null) {
    return Object.freeze({ layout: "compact", spans: Object.freeze({}) });
  }
  invariant(observed.schemaHeaderCount === 1, "PLAN_METADATA_INVALID", "A mutable TASK_PLAN.md must contain exactly one Schema header");
  invariant(SUPPORTED_LEDGER_SCHEMAS.has(observed.ledgerSchema), "PLAN_LEDGER_SCHEMA_UNSUPPORTED", "Ledger Markdown metadata requires a supported task-ledger schema");

  const lines = markdownLines(observed.text);
  const schemaLines = lines.map((line, index) => ({
    line,
    index,
    content: index === 0 && line.content.startsWith("\ufeff") ? line.content.slice(1) : line.content,
  })).filter(({ content }) => {
    const match = /^\*\*Schema:\*\*[ \t]*`([^`]+)`[ \t]*$/.exec(content);
    return match?.[1] === observed.ledgerSchema;
  });
  invariant(schemaLines.length === 1, "PLAN_METADATA_INVALID", "The authoritative Schema line must be structurally identifiable");

  const region = [];
  for (let index = schemaLines[0].index + 1; index < lines.length && lines[index].content.trim() !== ""; index += 1) region.push(lines[index]);
  const metadataLike = region.filter((line) => /^\*\*(?:Current revision|Requirements version|Updated):\*\*/.test(line.content));
  if (metadataLike.length === 0) return Object.freeze({ layout: "compact", spans: Object.freeze({}) });

  invariant(region.length === METADATA_HEADERS.length && metadataLike.length === METADATA_HEADERS.length, "PLAN_METADATA_MISMATCH", "Structural Ledger metadata must be exactly the three canonical lines immediately after Schema");
  const spans = {};
  for (let index = 0; index < METADATA_HEADERS.length; index += 1) {
    const definition = METADATA_HEADERS[index];
    const line = region[index];
    const match = definition.pattern.exec(line.content);
    invariant(match && match[1] === observed.task[definition.field], "PLAN_METADATA_MISMATCH", `Structural Ledger metadata does not match ${definition.field}`);
    const valueOffset = line.content.indexOf(match[1], match.index);
    spans[definition.field] = Object.freeze({ start: line.start + valueOffset, end: line.start + valueOffset + match[1].length, value: match[1] });
  }
  return Object.freeze({ layout: "extended", spans: Object.freeze(spans) });
}

function metadataReplacements(analysis, replacements) {
  const requested = Object.entries(replacements ?? {});
  if (analysis.layout === "compact") {
    invariant(requested.length === 0, "PLAN_MATERIALIZATION_INVALID", "Compact Ledger Markdown has no structural metadata spans");
    return [];
  }
  return requested.map(([field, value]) => {
    const span = analysis.spans[field];
    invariant(span && typeof value === "string", "PLAN_MATERIALIZATION_INVALID", `Unknown or invalid structural Ledger metadata replacement: ${field}`);
    return { ...span, expected: span.value, value };
  });
}

function replaceSpans(text, replacements) {
  const ordered = [...replacements].sort((left, right) => right.start - left.start);
  let previousStart = text.length + 1;
  let result = text;
  for (const replacement of ordered) {
    invariant(Number.isInteger(replacement.start) && Number.isInteger(replacement.end) && replacement.start >= 0 && replacement.end >= replacement.start && replacement.end <= text.length && replacement.end <= previousStart, "PLAN_MATERIALIZATION_INVALID", "Materialization spans overlap or are out of bounds");
    invariant(text.slice(replacement.start, replacement.end) === replacement.expected, "PLAN_METADATA_MISMATCH", "Structural Ledger materialization span changed unexpectedly");
    result = result.slice(0, replacement.start) + replacement.value + result.slice(replacement.end);
    previousStart = replacement.start;
  }
  return result;
}

export function replaceLedgerMetadataSpans(text, analysis, replacements) {
  return replaceSpans(text, metadataReplacements(analysis, replacements));
}

export function materializeLedgerMarkdown(observed, { json, metadata = {}, allowSchemalessCompact = false }) {
  invariant(typeof json === "string", "PLAN_MATERIALIZATION_INVALID", "Ledger JSON materialization must be a string");
  const analysis = analyzeLedgerMetadata(observed, { allowSchemalessCompact });
  const replacements = [{
    start: observed.block.jsonIndex,
    end: observed.block.jsonIndex + observed.block.json.length,
    expected: observed.block.json,
    value: json,
  }];
  if (analysis.layout === "extended") replacements.push(...metadataReplacements(analysis, metadata));
  return Object.freeze({ text: replaceSpans(observed.text, replacements), analysis });
}
