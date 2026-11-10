// FILE: GuestViewerPane.tsx
// Purpose: The guest page's viewer pane, where a page, a visualization or a linked file opens
//          the way it opens in the owner's right dock.
// Layer: Guest page UI
// Why: The owner opens an agent's page in the dock with zoom, source and save, and a linked file
//      in the file preview. A guest gets the same: pages use the owner's own preview pane (its
//      owner-only actions hide themselves for a shared viewer), and files load through the
//      share's `file` route, which serves only what the agent's replies link inside the thread's
//      folder. Beside the transcript on a wide screen, over it on a phone.

import {
  isSupportedLocalHtmlPath,
  lowerCaseExtensionOf,
  isSupportedLocalImagePath,
  isSupportedLocalVideoPath,
} from "@moss/shared/localPreviewFiles";
import { useEffect, useState, type ReactNode } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { HtmlRenderPreviewPane } from "~/components/chat/HtmlRenderPreviewPane";
import { LocalHtmlPreviewFrame } from "~/components/LocalHtmlPreviewFrame";
import { Button } from "~/components/ui/button";
import { DownloadIcon, XIcon } from "~/lib/icons";
import type { SharedFileReference } from "~/lib/sharedViewer";
import { useTranslation } from "~/localization";
import type { RightDockHtmlDocument } from "~/rightDockStore.logic";

import type { GuestTransport } from "../transport";

export type GuestViewerDocument =
  | { readonly kind: "html"; readonly document: RightDockHtmlDocument }
  | { readonly kind: "file"; readonly file: SharedFileReference }
  /** A turn's changes, or one file's part of them ("review changes"). */
  | { readonly kind: "diff"; readonly turnId: string; readonly filePath?: string | undefined };

/** Text past this is cut, with a note; the whole file is still a download away. */
const TEXT_PREVIEW_MAX_BYTES = 512 * 1024;
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdx"]);
/** Files read as bytes and shown as text when they decode as text. */
const BINARY_SNIFF_BYTES = 8192;

export function GuestViewerPane(props: {
  readonly threadId: string;
  readonly transport: GuestTransport;
  readonly viewing: GuestViewerDocument;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  const close = (
    <Button
      aria-label={t("guest.viewer.close")}
      title={t("guest.viewer.close")}
      size="icon-xs"
      variant="ghost"
      onClick={props.onClose}
      data-guest-viewer-close=""
    >
      <XIcon />
    </Button>
  );
  return (
    <aside
      className="fixed inset-0 z-40 flex min-h-0 min-w-0 flex-col bg-background md:static md:z-auto md:w-[min(50%,760px)] md:shrink-0 md:border-border/70 md:border-s"
      data-guest-viewer={props.viewing.kind}
    >
      {props.viewing.kind === "html" ? (
        <HtmlRenderPreviewPane
          // A new document gets a fresh pane (zoom, source view).
          key={documentKey(props.viewing.document)}
          threadId={props.threadId}
          document={props.viewing.document}
          headerEnd={close}
        />
      ) : props.viewing.kind === "file" ? (
        <GuestFilePane
          key={props.viewing.file.path}
          transport={props.transport}
          file={props.viewing.file}
          close={close}
        />
      ) : (
        <GuestDiffPane
          key={`${props.viewing.turnId}:${props.viewing.filePath ?? ""}`}
          transport={props.transport}
          turnId={props.viewing.turnId}
          filePath={props.viewing.filePath}
          close={close}
        />
      )}
    </aside>
  );
}

/** The patch sections of one file, matched by the path's tail as the change list names it. */
function diffOfFile(diff: string, filePath: string): string {
  const wanted = filePath.replaceAll("\\", "/").replace(/^\.\//u, "");
  return diff
    .split(/^(?=diff --git )/mu)
    .filter((section) => {
      const header = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/mu.exec(section);
      if (header === null) return false;
      return [header[1], header[2]].some(
        (name) => name !== undefined && (name === wanted || name.endsWith(`/${wanted}`)),
      );
    })
    .join("");
}

function GuestDiffPane(props: {
  readonly transport: GuestTransport;
  readonly turnId: string;
  readonly filePath: string | undefined;
  readonly close: ReactNode;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<
    | { readonly kind: "loading" }
    | { readonly kind: "unavailable" }
    | { readonly kind: "diff"; readonly text: string }
  >({ kind: "loading" });
  const url = props.transport.fileUrl({ diff: props.turnId });
  useEffect(() => {
    let active = true;
    void fetch(url, { credentials: "include" })
      .then(async (response) => (response.ok ? response.text() : null))
      .catch(() => null)
      .then((text) => {
        if (!active) return;
        const shown =
          text === null ? null : props.filePath ? diffOfFile(text, props.filePath) : text;
        setState(
          shown === null || shown.trim() === ""
            ? { kind: "unavailable" }
            : { kind: "diff", text: shown },
        );
      });
    return () => {
      active = false;
    };
  }, [props.filePath, url]);
  const title = props.filePath
    ? (props.filePath.split(/[\\/]/u).at(-1) ?? props.filePath)
    : t("guest.viewer.changes");
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 items-center gap-1 border-border/70 border-b px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate px-1 text-ui-xs font-medium" title={title}>
          {title}
        </span>
        {props.close}
      </header>
      {state.kind === "loading" ? (
        <div className="min-h-0 flex-1 animate-pulse bg-muted/20" />
      ) : state.kind === "unavailable" ? (
        <p className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-ui-sm text-muted-foreground">
          {t("guest.viewer.changesUnavailable")}
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3" data-guest-viewer-diff="">
          <ChatMarkdown text={fencedCode(state.text, "changes.diff")} cwd={undefined} />
        </div>
      )}
    </div>
  );
}

function documentKey(document: RightDockHtmlDocument): string {
  return document.kind === "html-render"
    ? `page:${document.attachmentId}`
    : `visualization:${document.path}`;
}

type FileView =
  | { readonly kind: "image" }
  | { readonly kind: "video" }
  | { readonly kind: "html" }
  | { readonly kind: "text"; readonly markdown: boolean };

function fileViewOf(name: string): FileView {
  if (isSupportedLocalImagePath(name)) return { kind: "image" };
  if (isSupportedLocalVideoPath(name)) return { kind: "video" };
  if (isSupportedLocalHtmlPath(name)) return { kind: "html" };
  return { kind: "text", markdown: MARKDOWN_EXTENSIONS.has(lowerCaseExtensionOf(name) ?? "") };
}

type TextState =
  | { readonly kind: "loading" }
  | { readonly kind: "text"; readonly text: string; readonly truncatedAt: number | null }
  | { readonly kind: "binary" }
  | { readonly kind: "unavailable" };

function GuestFilePane(props: {
  readonly transport: GuestTransport;
  readonly file: SharedFileReference;
  readonly close: ReactNode;
}) {
  const { t, format } = useTranslation();
  const fileUrl = props.transport.fileUrl({ src: props.file.path });
  const view = fileViewOf(props.file.name);
  const [mediaFailed, setMediaFailed] = useState(false);
  const [text, setText] = useState<TextState>({ kind: "loading" });

  useEffect(() => {
    if (view.kind !== "text") return;
    let active = true;
    void readTextPreview(fileUrl).then((state) => {
      if (active) setText(state);
    });
    return () => {
      active = false;
    };
  }, [fileUrl, view.kind]);

  const downloadOnly = (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="max-w-sm text-ui-sm text-muted-foreground">
        {format("guest.viewer.downloadOnly", { name: props.file.name })}
      </p>
      <Button
        size="sm"
        variant="outline"
        render={<a href={fileUrl} download={props.file.name} />}
        data-guest-viewer-download-only=""
      >
        <DownloadIcon />
        {t("guest.viewer.download")}
      </Button>
    </div>
  );
  const unavailable = (
    <p className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-ui-sm text-muted-foreground">
      {t("guest.viewer.unavailable")}
    </p>
  );

  let body: ReactNode;
  if (view.kind === "image") {
    body = mediaFailed ? (
      unavailable
    ) : (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        <img
          src={fileUrl}
          alt={props.file.name}
          className="max-h-full max-w-full object-contain"
          onError={() => setMediaFailed(true)}
        />
      </div>
    );
  } else if (view.kind === "video") {
    body = mediaFailed ? (
      downloadOnly
    ) : (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-black/90 p-2">
        <video
          src={fileUrl}
          controls
          playsInline
          className="max-h-full max-w-full"
          onError={() => setMediaFailed(true)}
        />
      </div>
    );
  } else if (view.kind === "html") {
    body = (
      // The owner's file panel's own frame: scripts in an opaque origin, and no message bridge
      // to the page, since a file from disk gets no channel to Moss.
      <LocalHtmlPreviewFrame
        src={props.transport.documentUrl({ file: props.file.path })}
        title={props.file.name}
        className="block min-h-0 w-full flex-1 bg-white scheme-light"
      />
    );
  } else if (text.kind === "loading") {
    body = <div className="min-h-0 flex-1 animate-pulse bg-muted/20" />;
  } else if (text.kind === "unavailable") {
    body = unavailable;
  } else if (text.kind === "binary") {
    body = downloadOnly;
  } else {
    const markdown = view.kind === "text" && view.markdown;
    body = (
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3" data-guest-viewer-text="">
        {text.truncatedAt !== null ? (
          <p className="mb-2 text-ui-xs text-muted-foreground">
            {format("guest.viewer.truncated", { size: formatBytes(text.truncatedAt) })}
          </p>
        ) : null}
        <ChatMarkdown
          text={markdown ? text.text : fencedCode(text.text, props.file.name)}
          cwd={undefined}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 items-center gap-1 border-border/70 border-b px-2 py-1.5">
        <span
          className="min-w-0 flex-1 truncate px-1 text-ui-xs font-medium"
          title={props.file.name}
        >
          {props.file.name}
        </span>
        <Button
          aria-label={t("guest.viewer.download")}
          title={t("guest.viewer.download")}
          size="icon-xs"
          variant="ghost"
          render={<a href={fileUrl} download={props.file.name} />}
        >
          <DownloadIcon />
        </Button>
        {props.close}
      </header>
      {body}
    </div>
  );
}

/** The file as text when it reads as text; binary files are offered as a download instead. */
async function readTextPreview(url: string): Promise<TextState> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: "include" });
  } catch {
    return { kind: "unavailable" };
  }
  if (!response.ok) return { kind: "unavailable" };
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { kind: "binary" };
  const truncated = bytes.byteLength > TEXT_PREVIEW_MAX_BYTES;
  const slice = truncated ? bytes.subarray(0, TEXT_PREVIEW_MAX_BYTES) : bytes;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: !truncated }).decode(slice);
  } catch {
    return { kind: "binary" };
  }
  return { kind: "text", text, truncatedAt: truncated ? TEXT_PREVIEW_MAX_BYTES : null };
}

/** A code fence long enough that no run of backticks in the file closes it early. */
function fencedCode(text: string, name: string): string {
  const longestRun = Math.max(0, ...Array.from(text.matchAll(/`+/gu), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const language = (lowerCaseExtensionOf(name) ?? "").slice(1);
  return `${fence}${language}\n${text}\n${fence}`;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${Math.round(bytes / (1024 * 1024))} MB`
    : `${Math.round(bytes / 1024)} KB`;
}
