import { withYjs, YjsEditor, yTextToSlateElement } from "@slate-yjs/core";
import { createEditor, Node, type Descendant } from "slate";
import { withReact } from "slate-react";
import * as Y from "yjs";

const limit = 256 * 1024;
const marks = new Set(["bold", "italic", "underline", "strikethrough", "code"]);
/** Decode just the public paragraph projection. An unsupported tree must never be normalized into an editable one. */
export function createGuestProjectionEditor(seed: Uint8Array) {
  if (seed.length === 0 || seed.length > limit) throw new Error("Invalid projection");
  const doc = new Y.Doc();
  try {
    const root = doc.get("content", Y.XmlText);
    Y.applyUpdate(doc, seed);
    if (
      doc.share.size !== 1 ||
      doc.getSubdocs().size ||
      doc.store.pendingDs ||
      doc.store.pendingStructs
    )
      throw new Error("Invalid projection");
    const nodes = yTextToSlateElement(root).children;
    if (
      !nodes.length ||
      nodes.length > 512 ||
      nodes.some((raw) => {
        const n = raw as unknown as { type: unknown; children?: Record<string, unknown>[] };
        return (
          n.type !== "p" ||
          Object.keys(n).some((k) => k !== "type" && k !== "children") ||
          !n.children?.length ||
          n.children.some(
            (t) =>
              typeof t.text !== "string" ||
              Object.keys(t).some((k) => k !== "text" && (!marks.has(k) || t[k] !== true)),
          )
        );
      })
    )
      throw new Error("Unsupported projection");
    const baseline = Y.encodeStateVector(doc);
    const editor = withReact(withYjs(createEditor(), root, { autoConnect: false }));
    YjsEditor.connect(editor);
    let dirty = false,
      released = false;
    const changed = () => {
      dirty = true;
    };
    doc.on("update", changed);
    return {
      editor,
      initial: editor.children as Descendant[],
      isDirty: () => {
        YjsEditor.flushLocalChanges(editor);
        return dirty;
      },
      update: () => {
        YjsEditor.flushLocalChanges(editor);
        const delta = Y.encodeStateAsUpdate(doc, baseline);
        if (!delta.length || delta.length > limit) throw new Error("Too much text");
        return delta;
      },
      text: () => editor.children.map((n) => Node.string(n)).join("\n"),
      dispose: () => {
        if (released) return;
        released = true;
        doc.off("update", changed);
        try {
          YjsEditor.disconnect(editor);
        } finally {
          doc.destroy();
        }
      },
    };
  } catch (error) {
    doc.destroy();
    throw error;
  }
}
export type GuestProjectionEditor = ReturnType<typeof createGuestProjectionEditor>;
