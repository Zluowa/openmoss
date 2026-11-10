// FILE: pageYjsContent.ts
// Purpose: Converts a Page's Plate JSON to and from its Yjs document, and turns a target value into
//          the smallest set of Slate operations so a server-side write merges with live edits.
// Layer: Pages realtime (collab)
// Why: The editor binds Slate to Yjs with @slate-yjs/core. The server writes through the same
//      binding so agents and compaction see exactly the tree the editor sees. The server editor
//      never normalizes: it does not know Plate's inline and void rules, and the editor already
//      normalized the tree it sent.

import { slateNodesToInsertDelta, withYjs, YjsEditor, yTextToSlateElement } from "@slate-yjs/core";
import { createEditor, type Descendant, type Operation } from "slate";
import * as Y from "yjs";

export const PAGE_YJS_ROOT = "content";

export type PlateNode = Record<string, unknown>;

const EMPTY_PARAGRAPH: PlateNode = { type: "p", children: [{ text: "" }] };

/** Element children never stay empty, and the document never starts empty: two clients that
 * each "fix" an empty tree at the same time would otherwise both insert a paragraph. */
export function normalizePlateValue(value: readonly unknown[]): PlateNode[] {
  const fix = (node: PlateNode): PlateNode => {
    if (typeof node.text === "string") return node;
    const children = Array.isArray(node.children) ? (node.children as PlateNode[]) : [];
    return { ...node, children: children.length ? children.map(fix) : [{ text: "" }] };
  };
  const nodes = (value as PlateNode[]).filter(
    (node) => node && typeof node === "object" && typeof node.text !== "string",
  );
  // Plate's trailing-block rule appends a paragraph after a final non-paragraph block. Doing it
  // here, once, keeps every connecting editor from appending its own copy.
  const fixed = nodes.length ? nodes.map(fix) : [EMPTY_PARAGRAPH];
  const last = fixed[fixed.length - 1];
  return last && last.type !== "p" ? [...fixed, EMPTY_PARAGRAPH] : fixed;
}

export function pageRoot(doc: Y.Doc): Y.XmlText {
  return doc.get(PAGE_YJS_ROOT, Y.XmlText);
}

/** Fills an empty document. Only the server seeds; clients wait for its first sync. */
export function seedPageDoc(doc: Y.Doc, value: readonly unknown[], origin?: unknown): void {
  const root = pageRoot(doc);
  if (root.length > 0) throw new Error("Page realtime document is already seeded.");
  doc.transact(() => {
    root.applyDelta(
      slateNodesToInsertDelta(normalizePlateValue(value) as unknown as Descendant[]),
      {
        sanitize: false,
      },
    );
  }, origin);
}

export function readPageDoc(doc: Y.Doc): PlateNode[] {
  return yTextToSlateElement(pageRoot(doc)).children as unknown as PlateNode[];
}

const isText = (node: PlateNode) => typeof node.text === "string";
const propsOf = (node: PlateNode) => {
  const { children: _children, text: _text, ...props } = node;
  return props;
};
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function propertyChange(a: PlateNode, b: PlateNode) {
  const before = propsOf(a);
  const after = propsOf(b);
  const properties: Record<string, unknown> = {};
  const newProperties: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (equal(before[key], after[key])) continue;
    if (key in before) properties[key] = before[key];
    if (key in after) newProperties[key] = after[key];
  }
  return Object.keys(properties).length || Object.keys(newProperties).length
    ? { properties, newProperties }
    : null;
}

/** Operations that turn `from` into `to`. Unchanged leading and trailing siblings are kept,
 * changed siblings are edited in place pairwise (properties, then children down to characters)
 * and the surplus is removed or inserted. Every path is valid when its operation applies. */
export function diffPlateValue(from: readonly PlateNode[], to: readonly PlateNode[]): Operation[] {
  const ops: Operation[] = [];
  const children = (path: number[], a: readonly PlateNode[], b: readonly PlateNode[]) => {
    let start = 0;
    while (start < a.length && start < b.length && equal(a[start], b[start])) start += 1;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && equal(a[endA - 1], b[endB - 1])) {
      endA -= 1;
      endB -= 1;
    }
    const middleA = a.slice(start, endA);
    const middleB = b.slice(start, endB);
    const paired = Math.min(middleA.length, middleB.length);
    for (let index = 0; index < paired; index += 1) {
      const left = middleA[index]!;
      const right = middleB[index]!;
      const at = [...path, start + index];
      // A block that only changed type (paragraph to heading) keeps its identity, so typing
      // inside it while it changes is kept.
      const sameKind = isText(left) === isText(right);
      if (!sameKind) {
        ops.push({ type: "remove_node", path: at, node: left as unknown as Descendant });
        ops.push({ type: "insert_node", path: at, node: right as unknown as Descendant });
        continue;
      }
      const change = propertyChange(left, right);
      if (change) ops.push({ type: "set_node", path: at, ...change } as Operation);
      if (isText(left)) text(at, String(left.text), String(right.text));
      else children(at, left.children as PlateNode[], right.children as PlateNode[]);
    }
    for (let index = middleA.length - 1; index >= paired; index -= 1) {
      ops.push({
        type: "remove_node",
        path: [...path, start + index],
        node: middleA[index] as unknown as Descendant,
      });
    }
    for (let index = paired; index < middleB.length; index += 1) {
      ops.push({
        type: "insert_node",
        path: [...path, start + index],
        node: middleB[index] as unknown as Descendant,
      });
    }
  };
  const text = (path: number[], a: string, b: string) => {
    if (a === b) return;
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
    let end = 0;
    while (
      end < a.length - start &&
      end < b.length - start &&
      a[a.length - 1 - end] === b[b.length - 1 - end]
    )
      end += 1;
    const removed = a.slice(start, a.length - end);
    const inserted = b.slice(start, b.length - end);
    if (removed) ops.push({ type: "remove_text", path, offset: start, text: removed });
    if (inserted) ops.push({ type: "insert_text", path, offset: start, text: inserted });
  };
  children([], from, to);
  return ops;
}

/** Applies `target` to the document as one transaction tagged with `origin`, merging with
 * whatever else the document already holds. Returns the number of Slate operations. */
export function applyPlateValue(doc: Y.Doc, target: readonly unknown[], origin: unknown): number {
  const editor = withYjs(createEditor(), pageRoot(doc), {
    autoConnect: false,
    localOrigin: origin,
  });
  editor.normalizeNode = () => {};
  YjsEditor.connect(editor);
  try {
    const ops = diffPlateValue(
      editor.children as unknown as PlateNode[],
      normalizePlateValue(target),
    );
    if (!ops.length) return 0;
    for (const op of ops) editor.apply(op);
    YjsEditor.flushLocalChanges(editor);
    return ops.length;
  } finally {
    YjsEditor.disconnect(editor);
  }
}

/** Replays `from` → `to` on a copy of `base` and applies only that difference to `doc`. When
 * `base` is the state the writer read, concurrent edits made since then survive character by
 * character; Yjs places the writer's insertions relative to the text they were made against. */
export function mergePlateEdit(input: {
  readonly doc: Y.Doc;
  readonly base: Uint8Array;
  readonly target: readonly unknown[];
  readonly origin: unknown;
  /** The outside Page's own state, without newer edits from the live room. */
  readonly onTargetState?: (state: Uint8Array) => void;
}): number {
  const fork = new Y.Doc();
  try {
    Y.applyUpdate(fork, input.base);
    const before = Y.encodeStateVector(fork);
    const count = applyPlateValue(fork, input.target, null);
    if (count > 0) Y.applyUpdate(input.doc, Y.encodeStateAsUpdate(fork, before), input.origin);
    input.onTargetState?.(Y.encodeStateAsUpdate(fork));
    return count;
  } finally {
    fork.destroy();
  }
}
