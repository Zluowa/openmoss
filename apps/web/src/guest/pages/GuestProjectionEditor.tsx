import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import { Editable, Slate, type RenderLeafProps, type RenderElementProps } from "slate-react";
import { Button } from "~/components/ui/button";
import { createGuestProjectionEditor, type GuestProjectionEditor } from "./guestProjectionSlate";
import {
  GuestEditError,
  type GuestEditEntry,
  type GuestEditTransport,
  type OpenedProjection,
} from "./guestPageEditTransport";
import type { PageGuestCopy } from "./pageGuestCopy";

type Status =
  | "opening"
  | "editing"
  | "saving"
  | "conflict"
  | "unavailable"
  | "unsupported"
  | "uncertain"
  | "limit";
const leaf = (props: RenderLeafProps) => {
  const l: RenderLeafProps["leaf"] &
    Partial<Record<"bold" | "italic" | "underline" | "strikethrough" | "code", boolean>> =
    props.leaf;
  let content = props.children;
  if (l.bold) content = <strong>{content}</strong>;
  if (l.italic) content = <em>{content}</em>;
  if (l.underline) content = <u>{content}</u>;
  if (l.strikethrough) content = <s>{content}</s>;
  if (l.code) content = <code>{content}</code>;
  return <span {...props.attributes}>{content}</span>;
};
export default function GuestProjectionEditor(props: {
  readonly pageId: string;
  readonly entry: GuestEditEntry;
  readonly transport: GuestEditTransport;
  readonly words: PageGuestCopy["editor"];
  readonly dirty: (value: boolean) => void;
  readonly finish: (saved: boolean) => void;
}) {
  const { pageId, entry, transport, words } = props;
  const [status, setStatus] = useState<Status>("opening"),
    [model, setModel] = useState<GuestProjectionEditor | null>(null);
  const [discarding, setDiscarding] = useState(false),
    [hasChanges, setHasChanges] = useState(false);
  const session = useRef<OpenedProjection | null>(null),
    life = useRef<AbortController | null>(null),
    request = useRef<Uint8Array | null>(null);
  const state = useRef<Status>("opening"),
    valid = useRef(false),
    streamReady = useRef(false);
  const change = (s: Status) => {
    state.current = s;
    setStatus(s);
  };
  const entryKey = JSON.stringify(entry);
  useEffect(() => {
    const stop = new AbortController();
    life.current = stop;
    let owned: OpenedProjection | null = null,
      editor: GuestProjectionEditor | null = null;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    valid.current = false;
    streamReady.current = false;
    request.current = null;
    const end = (s: Status) => {
      valid.current = false;
      if (state.current !== "saving" && state.current !== "uncertain") change(s);
    };
    const opening = setTimeout(() => {
      if (!stop.signal.aborted && !owned) {
        change("unavailable");
        stop.abort();
      }
    }, 8000);
    void (async () => {
      try {
        owned = await transport.open(pageId, entry, stop.signal);
        if (stop.signal.aborted) {
          void transport.close(pageId, entry, owned.ticket);
          return;
        }
        clearTimeout(opening);
        session.current = owned;
        editor = createGuestProjectionEditor(owned.seed);
        setModel(editor);
        expiry = setTimeout(() => end("unavailable"), Math.max(0, owned.expiresAt - Date.now()));
        const streamSignal = AbortSignal.any([
          stop.signal,
          AbortSignal.timeout(Math.max(1, owned.expiresAt - Date.now())),
        ]);
        await transport.events(pageId, entry, owned.ticket, streamSignal, (e) => {
          if (stop.signal.aborted) return;
          if (e.type === "ready") {
            if (e.revision !== owned?.revision || Date.now() >= owned.expiresAt) {
              end("conflict");
              return;
            }
            streamReady.current = true;
            valid.current = true;
            change("editing");
          } else end(e.type === "refresh" ? "conflict" : "unavailable");
        });
      } catch (error) {
        if (!stop.signal.aborted)
          end(
            error instanceof GuestEditError && error.reason === "unsupported"
              ? "unsupported"
              : "unavailable",
          );
      } finally {
        clearTimeout(opening);
      }
    })();
    return () => {
      stop.abort();
      clearTimeout(expiry);
      clearTimeout(opening);
      life.current = null;
      session.current = null;
      valid.current = false;
      if (owned) void transport.close(pageId, entry, owned.ticket);
      editor?.dispose();
    };
  }, [pageId, entryKey, transport]);
  const save = async (retry = false) => {
    const opened = session.current,
      signal = life.current?.signal;
    if (
      !opened ||
      !signal ||
      signal.aborted ||
      !model ||
      state.current === "saving" ||
      (!retry && (!valid.current || !streamReady.current)) ||
      Date.now() >= opened.expiresAt
    )
      return;
    let bytes = request.current;
    if (!retry) {
      try {
        bytes = model.update();
        request.current = bytes;
      } catch {
        change("limit");
        return;
      }
    }
    if (!bytes) return;
    change("saving");
    try {
      const result = await transport.submit(
        pageId,
        entry,
        opened.ticket,
        bytes,
        AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      );
      if (signal.aborted) return;
      if (result.revision !== opened.revision + (result.applied ? 1 : 0)) {
        change("uncertain");
        return;
      }
      props.dirty(false);
      props.finish(true);
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof GuestEditError && error.reason === "conflict") {
        valid.current = false;
        change("conflict");
      } else if (
        error instanceof GuestEditError &&
        (error.reason === "unavailable" ||
          error.reason === "forbidden" ||
          error.reason === "unsupported")
      ) {
        valid.current = false;
        change("unavailable");
      } else change("uncertain");
    }
  };
  const cancel = () => {
    if (hasChanges && !discarding) {
      setDiscarding(true);
      return;
    }
    props.dirty(false);
    props.finish(false);
  };
  const writable = status === "editing" || status === "limit";
  return (
    <section
      aria-label={words.title}
      className="my-4 space-y-3 rounded-card border border-border p-4"
      data-guest-edit=""
    >
      <h2 className="text-base font-semibold">{words.title}</h2>
      <p role="status" className="text-ui-sm text-muted-foreground">
        {words[status]}
      </p>
      {model ? (
        <Slate
          editor={model.editor}
          initialValue={model.initial}
          onChange={() => {
            if (writable && !hasChanges && model.isDirty()) {
              setHasChanges(true);
              props.dirty(true);
            }
          }}
        >
          <Editable
            role="textbox"
            aria-multiline="true"
            aria-readonly={!writable}
            aria-label={words.text}
            readOnly={!writable}
            spellCheck
            renderLeaf={leaf}
            renderElement={(p: RenderElementProps) => <p {...p.attributes}>{p.children}</p>}
            className="min-h-24 rounded border border-border p-3 outline-none focus-visible:ring-2"
            onPaste={(event: ClipboardEvent<HTMLDivElement>) => {
              event.preventDefault();
              if (!writable) return;
              const text = event.clipboardData.getData("text/plain");
              if (new TextEncoder().encode(text).length > 128 * 1024) {
                change("limit");
                return;
              }
              model.editor.insertText(text);
            }}
          />
        </Slate>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {writable ? (
          <Button size="sm" disabled={!hasChanges} onClick={() => void save()}>
            {words.save}
          </Button>
        ) : null}
        {status === "uncertain" &&
        request.current &&
        session.current &&
        Date.now() < session.current.expiresAt ? (
          <Button size="sm" onClick={() => void save(true)}>
            {words.retryReceipt}
          </Button>
        ) : null}
        <Button size="sm" variant="outline" disabled={status === "saving"} onClick={cancel}>
          {discarding ? words.discard : words.close}
        </Button>
        {discarding ? (
          <Button variant="ghost" size="sm" onClick={() => setDiscarding(false)}>
            {words.keep}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
