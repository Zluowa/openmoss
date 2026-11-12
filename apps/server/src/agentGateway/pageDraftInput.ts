// FILE: pageDraftInput.ts
// Purpose: Accepts the moss_pages_draft arguments weaker models actually send. Acceptance
//          round 10 saw a model fail nine times to hand-escape a Plate node array inside the
//          `richContent` string. The common mistakes are repaired here (an array or object
//          where a string is expected, a code fence, a doubly escaped string, `type` for
//          `kind`, ops sent as a JSON string); what cannot be repaired gets a hint that says
//          exactly what to resend.
// Layer: Server agent gateway (pure)

const FENCE = /^```[a-z]*\s*\n([\s\S]*?)\n?```$/iu;

type Args = Record<string, unknown>;

const isRecord = (value: unknown): value is Args =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A string that is JSON, perhaps fenced or escaped one time too many, as a value. */
export function parseLooseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  let candidate = text.trim();
  const fenced = FENCE.exec(candidate);
  if (fenced) candidate = fenced[1]!.trim();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const value: unknown = JSON.parse(candidate);
      // A JSON string that holds JSON: the model escaped it one level too deep.
      if (typeof value === "string" && /^\s*[[{]/u.test(value)) {
        candidate = value.trim();
        continue;
      }
      return { ok: true, value };
    } catch {
      // `[{\"type\":…}]` written without the outer quotes: undo one level of escaping.
      if (attempt === 0 && /\\["\\]/u.test(candidate)) {
        candidate = candidate.replace(/\\(["\\/])/gu, "$1");
        continue;
      }
      return { ok: false };
    }
  }
  return { ok: false };
}

/** The richContent value as the canonical JSON string of a node array, or a hint. */
export function normalizeRichContent(value: unknown): { richContent: string } | { hint: string } {
  let nodes: unknown = value;
  if (typeof value === "string") {
    const parsed = parseLooseJson(value);
    if (!parsed.ok)
      return {
        hint: 'richContent is not valid JSON. Send it as a JSON array of nodes (not a string), e.g. "richContent": [{"type":"p","children":[{"text":"…"}]}], or send markdown instead. For a chart use moss_app_visualize.',
      };
    nodes = parsed.value;
  }
  if (isRecord(nodes)) nodes = [nodes];
  if (!Array.isArray(nodes))
    return { hint: "richContent must be an array of Plate nodes (or markdown text instead)." };
  return { richContent: JSON.stringify(nodes) };
}

const OP_KINDS = new Set(["insert", "replace", "delete", "replace-all", "deck"]);

function normalizeOp(raw: unknown, index: number): { op: Args } | { hint: string } {
  let op = raw;
  if (typeof op === "string") {
    const parsed = parseLooseJson(op);
    op = parsed.ok ? parsed.value : op;
  }
  if (!isRecord(op)) return { hint: `ops[${index}] must be an object like {"kind":"insert",…}.` };
  const next: Args = { ...op };
  if (next.kind === undefined && typeof next.type === "string" && OP_KINDS.has(next.type)) {
    next.kind = next.type;
    delete next.type;
  }
  if (next.kind === undefined && typeof next.op === "string" && OP_KINDS.has(next.op)) {
    next.kind = next.op;
    delete next.op;
  }
  if (typeof next.kind !== "string" || !OP_KINDS.has(next.kind))
    return {
      hint: `ops[${index}].kind must be "insert", "replace", "delete" or "replace-all".`,
    };
  if ((next.kind === "replace" || next.kind === "delete") && next.blockId === undefined) {
    if (typeof next.id === "string") next.blockId = next.id;
    else if (typeof next.block_id === "string") next.blockId = next.block_id;
    delete next.id;
    delete next.block_id;
    if (typeof next.blockId !== "string")
      return {
        hint: `ops[${index}] (${next.kind}) needs blockId: a top-level node id from moss_pages_read richContent.`,
      };
  }
  // Both bodies at once: the rich one is the precise one.
  if (next.richContent !== undefined && next.richContent !== null) {
    const rich = normalizeRichContent(next.richContent);
    if ("hint" in rich) return { hint: `ops[${index}]: ${rich.hint}` };
    next.richContent = rich.richContent;
    delete next.markdown;
  } else {
    delete next.richContent;
    if (next.markdown !== undefined && typeof next.markdown !== "string")
      return { hint: `ops[${index}].markdown must be text.` };
    if (typeof next.markdown === "string") {
      const fenced = /^```(?:markdown|md)\s*\n([\s\S]*?)\n?```$/iu.exec(next.markdown.trim());
      if (fenced) next.markdown = fenced[1]!;
    }
  }
  return { op: next };
}

/**
 * moss_pages_draft arguments in the shape the drafts service expects, or one hint naming the
 * field to fix. `baseRevision` is left out when the model gave none (the caller fills it).
 */
export function normalizePageDraftArgs(raw: unknown): { args: Args } | { hint: string } {
  let input = raw;
  if (typeof input === "string") {
    const parsed = parseLooseJson(input);
    input = parsed.ok ? parsed.value : input;
  }
  if (!isRecord(input)) return { hint: "Send the draft as an object with pageId and ops." };
  const args: Args = { ...input };
  if (args.scopeSpaceId === undefined) args.scopeSpaceId = null;
  if (typeof args.pageId !== "string" || !args.pageId.trim())
    return { hint: "pageId is required: the page you read with moss_pages_read." };
  if (typeof args.baseRevision === "string" && /^\d+$/u.test(args.baseRevision))
    args.baseRevision = Number(args.baseRevision);
  if (args.baseRevision === undefined && typeof args.revision === "number") {
    args.baseRevision = args.revision;
    delete args.revision;
  }
  let ops = args.ops;
  if (typeof ops === "string") {
    const parsed = parseLooseJson(ops);
    if (!parsed.ok)
      return {
        hint: 'ops is not valid JSON. Send ops as an array, e.g. "ops": [{"kind":"insert","afterBlockId":"…","markdown":"…"}].',
      };
    ops = parsed.value;
  }
  if (isRecord(ops)) ops = [ops];
  if (ops === undefined && typeof args.kind === "string" && OP_KINDS.has(args.kind)) {
    // A single op spread over the top level.
    const { requestId, scopeSpaceId, pageId, baseRevision, summary, ...op } = args;
    return normalizePageDraftArgs({
      requestId,
      scopeSpaceId,
      pageId,
      baseRevision,
      summary,
      ops: [op],
    });
  }
  if (!Array.isArray(ops) || ops.length === 0)
    return { hint: "ops is required: an array with at least one change." };
  const normalized: Args[] = [];
  for (const [index, op] of ops.entries()) {
    const next = normalizeOp(op, index);
    if ("hint" in next) return next;
    normalized.push(next.op);
  }
  args.ops = normalized;
  if (args.kind !== undefined && !["text", "image", "visualization"].includes(String(args.kind)))
    delete args.kind;
  return { args };
}
