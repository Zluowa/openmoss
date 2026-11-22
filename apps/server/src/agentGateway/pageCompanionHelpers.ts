// FILE: pageCompanionHelpers.ts
// Purpose: Shared companion-context parsing, applyMode resolution (`auto` vs `draft`),
//          rich agent awareness telemetry (`thinking` | `editing` | `done`), and
//          server-side live auto-apply helpers for agentGateway page/space tools.
// Layer: Server agent gateway. Uses zero sync FS calls and preserves existing tool contracts.

import { randomUUID } from "node:crypto";

import type { PageDraftOp } from "@moss/contracts";
import {
  parsePageRichContent,
  projectPageRichNodes,
  type PageRichNode,
} from "@moss/shared/pageRichContent";

import { prepareDraftOpsForPage } from "../pages/drafts/pageDraftBlocks";
import { validatePageDraftOps } from "../pages/drafts/Layers/PageDraftsService";
import type { PageRealtimeServiceShape } from "../pages/realtime/PageRealtimeService";

export type SpaceApplyMode = "auto" | "draft";

export interface CompanionContextMeta {
  readonly kind?: string;
  readonly itemId?: string;
  readonly selection?: unknown;
}

export interface ExtractedCompanionMeta {
  readonly companionContext?: CompanionContextMeta;
  readonly applyMode?: SpaceApplyMode;
  readonly targetBlockIds: readonly string[];
  readonly blockIds: readonly string[];
  readonly cleanArgs: Record<string, unknown>;
}

export const COMPANION_CONTEXT_SCHEMA_PROPERTY = {
  type: "object",
  description:
    "Optional live canvas companion metadata (item kind, itemId, active selection/blockIds) passed when invoked from SpaceCanvasChatDock.",
} as const;

export const APPLY_MODE_SCHEMA_PROPERTY = {
  type: "string",
  enum: ["auto", "draft"],
  description:
    'Optional apply mode. Pass "auto" for immediate live auto-apply (returns undoRevision for one-click undo), or "draft" to keep 建议模式 reviewable proposals.',
} as const;

export const TARGET_BLOCK_IDS_SCHEMA_PROPERTY = {
  type: "array",
  items: { type: "string" },
  description: "Optional block ids highlighted by live Moss presence while editing.",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanBlockIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim().slice(0, 120));
}

export function extractCompanionMeta(rawArgs: unknown): ExtractedCompanionMeta {
  if (!isRecord(rawArgs)) {
    return { targetBlockIds: [], blockIds: [], cleanArgs: {} };
  }
  const { companionContext, applyMode, targetBlockIds, ...rest } = rawArgs;
  const parsedMode: SpaceApplyMode | undefined =
    applyMode === "auto" || applyMode === "draft" ? applyMode : undefined;

  let parsedCompanion: CompanionContextMeta | undefined;
  let selectionBlockIds: string[] = [];
  if (isRecord(companionContext)) {
    parsedCompanion = {
      ...(typeof companionContext.kind === "string" ? { kind: companionContext.kind } : {}),
      ...(typeof companionContext.itemId === "string" ? { itemId: companionContext.itemId } : {}),
      ...(companionContext.selection !== undefined
        ? { selection: companionContext.selection }
        : {}),
    };
    if (isRecord(companionContext.selection)) {
      selectionBlockIds = cleanBlockIdList(companionContext.selection.blockIds);
      if (typeof companionContext.selection.blockId === "string") {
        selectionBlockIds.push(companionContext.selection.blockId.trim().slice(0, 120));
      }
    }
  }

  const parsedTargetIds = cleanBlockIdList(targetBlockIds);
  const blockIds = [...new Set([...parsedTargetIds, ...selectionBlockIds])].slice(0, 50);

  return {
    ...(parsedCompanion ? { companionContext: parsedCompanion } : {}),
    ...(parsedMode ? { applyMode: parsedMode } : {}),
    targetBlockIds: parsedTargetIds,
    blockIds,
    cleanArgs: rest,
  };
}

export function collectDraftOpBlockIds(
  ops: ReadonlyArray<Record<string, unknown>>,
  extra: readonly string[] = [],
): string[] {
  const ids: string[] = [...extra];
  for (const op of ops) {
    if (typeof op.blockId === "string" && op.blockId.trim()) ids.push(op.blockId.trim());
    if (typeof op.afterBlockId === "string" && op.afterBlockId.trim()) {
      ids.push(op.afterBlockId.trim());
    }
    if (typeof op.beforeBlockId === "string" && op.beforeBlockId.trim()) {
      ids.push(op.beforeBlockId.trim());
    }
  }
  return [...new Set(ids)].slice(0, 50);
}

export function emitAgentPresence(
  realtime: PageRealtimeServiceShape | undefined,
  pageId: string,
  threadId: string,
  state: "thinking" | "editing" | "done",
  label: string,
  blockIds?: readonly string[],
): void {
  realtime?.showAgent(pageId, threadId, {
    name: "Moss",
    state,
    label,
    ...(blockIds && blockIds.length > 0 ? { blockIds } : {}),
    threadId,
  });
}

function withBlockId(node: PageRichNode): PageRichNode {
  if (typeof node.id === "string" && node.id.trim().length > 0) return node;
  return { ...node, id: randomUUID() };
}

function markdownToNodes(markdown: string): PageRichNode[] {
  const normalized = markdown.replace(/\r\n/gu, "\n").trim();
  if (!normalized) return [withBlockId({ type: "p", children: [{ text: "" }] })];
  const blocks = normalized.split(/\n{2,}/u).filter((chunk) => chunk.trim().length > 0);
  if (blocks.length === 0) return [withBlockId({ type: "p", children: [{ text: "" }] })];
  return blocks.map((block) => {
    const trimmed = block.trim();
    const headingMatch = /^(#{1,6})\s+([\s\S]+)$/u.exec(trimmed);
    if (headingMatch) {
      const level = Math.min(headingMatch[1]!.length, 6);
      return withBlockId({
        type: `h${level}`,
        children: [{ text: headingMatch[2]!.trim() }],
      });
    }
    if (trimmed.startsWith("> ")) {
      return withBlockId({
        type: "blockquote",
        children: [{ text: trimmed.replace(/^>\s?/gmu, "").trim() }],
      });
    }
    return withBlockId({
      type: "p",
      children: [{ text: trimmed }],
    });
  });
}

function resolveOpNodes(
  op: Exclude<PageDraftOp, { readonly kind: "delete" | "deck" }>,
): PageRichNode[] {
  if (typeof op.richContent === "string") {
    return parsePageRichContent(op.richContent).nodes.map(withBlockId);
  }
  return markdownToNodes(op.markdown ?? "");
}

/** Applies validated `PageDraftOp[]` directly to current page content for live auto-apply mode. */
export function applyDraftOpsToRichPage(input: {
  readonly ops: readonly PageDraftOp[];
  readonly currentRichContent: string | null;
  readonly currentContent: string;
}): {
  readonly richContent: string | null;
  readonly content: string;
  readonly touchedBlockIds: string[];
} {
  validatePageDraftOps(input.ops);
  const baseNodes = input.currentRichContent
    ? parsePageRichContent(input.currentRichContent).nodes.map(withBlockId)
    : markdownToNodes(input.currentContent);
  const preparedOps = prepareDraftOpsForPage(input.ops, baseNodes);

  let nodes = [...baseNodes];
  const touchedBlockIds: string[] = [];

  for (const op of preparedOps) {
    if (op.kind === "deck") {
      throw new Error("Deck draft ops cannot auto-apply through page body auto-apply.");
    }
    if (op.kind === "replace-all") {
      if (op.markdown !== undefined && input.currentRichContent === null) {
        return {
          richContent: null,
          content: op.markdown,
          touchedBlockIds,
        };
      }
      nodes = resolveOpNodes(op);
      for (const n of nodes) {
        if (typeof n.id === "string") touchedBlockIds.push(n.id);
      }
      continue;
    }
    if (op.kind === "delete") {
      const idx = nodes.findIndex((node) => node.id === op.blockId);
      if (idx === -1) throw new Error(`Block ${op.blockId} was not found on this page.`);
      nodes.splice(idx, 1);
      touchedBlockIds.push(op.blockId);
      continue;
    }
    if (op.kind === "replace") {
      const idx = nodes.findIndex((node) => node.id === op.blockId);
      if (idx === -1) throw new Error(`Block ${op.blockId} was not found on this page.`);
      const replacement = resolveOpNodes(op);
      nodes.splice(idx, 1, ...replacement);
      for (const n of replacement) {
        if (typeof n.id === "string") touchedBlockIds.push(n.id);
      }
      continue;
    }
    if (op.kind === "insert") {
      const inserted = resolveOpNodes(op);
      if (op.atStart) {
        nodes.unshift(...inserted);
      } else if (op.afterBlockId) {
        const afterIdx = nodes.findIndex((node) => node.id === op.afterBlockId);
        if (afterIdx === -1) {
          throw new Error(`Anchor block ${op.afterBlockId} was not found on this page.`);
        }
        nodes.splice(afterIdx + 1, 0, ...inserted);
      } else {
        nodes.push(...inserted);
      }
      for (const n of inserted) {
        if (typeof n.id === "string") touchedBlockIds.push(n.id);
      }
    }
  }

  const normalized = parsePageRichContent(JSON.stringify(nodes));
  return {
    richContent: normalized.richContent,
    content: projectPageRichNodes(normalized.nodes),
    touchedBlockIds: [...new Set(touchedBlockIds)],
  };
}
