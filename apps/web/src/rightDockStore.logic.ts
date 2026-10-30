// FILE: rightDockStore.logic.ts
// Purpose: Pure, testable transitions for the right dock (tabbed multi-pane right sidebar).
// Layer: UI state helpers
// Exports: dock pane types, default-state factory, and immutable open/close/activate helpers.

import { arrayMove } from "@dnd-kit/sortable";
import type { ProjectId, ThreadId, TurnId } from "@synara/contracts";
import { resolveTabAfterClose } from "./lib/tabStrip";
import { sanitizeMossCanvasImageFocus, type MossCanvasImageFocus } from "./lib/mossCanvasBridge";
import { isPlainObject, sanitizeStringKeyedRecord } from "./persistedRecord";
import type { CodexPreviewEntry } from "./lib/codexPreviewClassifier";

// Single source of truth for the dock pane kinds. The union type, the runtime
// validator, the per-kind metadata map, and the add-menu order are all derived
// from this list so they can never drift apart.
export const RIGHT_DOCK_PANE_KINDS = [
  "browser",
  "device",
  "diff",
  "explorer",
  "file",
  "htmlRender",
  "imagePreview",
  "canvas",
  "terminal",
  "sidechat",
  "subagents",
  "git",
  "pullRequest",
] as const;

export type RightDockPaneKind = (typeof RIGHT_DOCK_PANE_KINDS)[number];
export type PullRequestInitialTab = "summary" | "timeline" | "code";

const RIGHT_DOCK_PANE_KIND_SET: ReadonlySet<string> = new Set(RIGHT_DOCK_PANE_KINDS);

export interface RightDockImagePreviewImage {
  id: string;
  path: string;
  name: string;
}

export type RightDockImagePreviewView = "single" | "playground";

export interface RightDockImagePreviewState {
  images: RightDockImagePreviewImage[];
  activeImageId: string | null;
  cwd: string | null;
  conversationTitle: string | null;
  view: RightDockImagePreviewView;
  /** Safe grouping metadata for the one gallery opened by this pane. */
  groupId?: string;
  createdAt?: string | null;
}

/** A persisted reference to a sandboxed visual reply; never a signed frame URL. */
export type RightDockHtmlDocument =
  | {
      readonly kind: "html-render";
      readonly attachmentId: string;
      readonly title: string;
    }
  | {
      readonly kind: "inline-visualization";
      readonly path: string;
      readonly title: string;
    };

export interface RightDockPane {
  canvasImage?: MossCanvasImageFocus;
  id: string;
  kind: RightDockPaneKind;
  // sidechat panes point at the embedded thread.
  threadId: ThreadId | null;
  // subagents panes keep their source lineage separate from the selected child
  // transcript. A selected child must never become the source for a reopen.
  subagentsSourceThreadId?: ThreadId | null;
  subagentsSelectedThreadId?: ThreadId | null;
  subagentsSelectedDisplayName?: string | null;
  // diff panes remember which turn/file they were opened on.
  diffTurnId: TurnId | null;
  diffFilePath: string | null;
  // file panes preview one workspace-relative file.
  filePath: string | null;
  previewEntry?: CodexPreviewEntry;
  /** Agent-authored page opened from an inline visual reply. */
  htmlDocument?: RightDockHtmlDocument;
  // Generated image previews keep only local filesystem metadata so the
  // authenticated image URL is rebuilt in memory by the pane renderer.
  imagePreview?: RightDockImagePreviewState | null;
  pullRequestProjectId: ProjectId | null;
  pullRequestRepository: string | null;
  pullRequestNumber: number | null;
  pullRequestInitialTab: PullRequestInitialTab | null;
}

/**
 * The GitHub inbox hosts a dock without a thread: standalone side chats about the selected
 * item. It is keyed by this fixed id, which can never collide with a thread id.
 */
export const GITHUB_INBOX_DOCK_HOST_ID = "github-inbox";
/** Who owns a dock: a chat thread, or the GitHub inbox page. */
export type RightDockHostId = ThreadId | typeof GITHUB_INBOX_DOCK_HOST_ID;

export interface RightDockThreadState {
  open: boolean;
  panes: RightDockPane[];
  activePaneId: string | null;
}

// Terminals and file previews have independent tabs. Side chats share one destination.
const MULTI_INSTANCE_PANE_KINDS: ReadonlySet<RightDockPaneKind> = new Set([
  "file",
  "htmlRender",
  "terminal",
]);

// Kinds that can only ever have one instance per host thread, derived as
// "every kind that is not multi-instance" so the two sets can never drift.
export const SINGLETON_PANE_KINDS: ReadonlySet<RightDockPaneKind> = new Set(
  RIGHT_DOCK_PANE_KINDS.filter((kind) => !MULTI_INSTANCE_PANE_KINDS.has(kind)),
);

export function isSingletonPaneKind(kind: RightDockPaneKind): boolean {
  return SINGLETON_PANE_KINDS.has(kind);
}

export function createDefaultRightDockState(): RightDockThreadState {
  return {
    open: false,
    panes: [],
    activePaneId: null,
  };
}

export function isRightDockPaneKind(value: unknown): value is RightDockPaneKind {
  return typeof value === "string" && RIGHT_DOCK_PANE_KIND_SET.has(value);
}

function sanitizeLocalImagePath(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const path = value.trim();
  if (
    path.length === 0 ||
    path.includes("\u0000") ||
    /(?:token|grant|access[_-]?token|preview[_-]?grant)=/i.test(path)
  ) {
    return null;
  }
  // A preview pane must be able to rebuild its URL from a local path. Keep
  // Unix and Windows filesystem paths, but reject every URI scheme (including
  // moss://, data:, blob:, and file:) from persisted state.
  if (path.startsWith("//") || (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path))) {
    return null;
  }
  return path;
}

function imagePreviewFallbackName(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function sanitizeImagePreviewDisplayText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  if (
    text.length === 0 ||
    text.includes("\u0000") ||
    /(?:token|grant|access[_-]?token|preview[_-]?grant)=/i.test(text) ||
    /(?:moss:\/\/|data:|blob:)/i.test(text)
  ) {
    return null;
  }
  return text;
}

function sanitizeImagePreviewGroupId(value: unknown): string | null {
  const groupId = sanitizeImagePreviewDisplayText(value);
  if (groupId === null || groupId.length > 256) {
    return null;
  }
  if (groupId.startsWith("generated-image-gallery:")) {
    return /^generated-image-gallery:[a-z\d._-]{1,240}$/iu.test(groupId) ? groupId : null;
  }
  if (!/^[a-z\d._-]{1,256}$/iu.test(groupId)) {
    return null;
  }
  return groupId;
}

function generatedImagePreviewFallbackGroupId(imageId: unknown): string {
  const suffix =
    typeof imageId === "string" && /^[a-z\d._-]{1,240}$/iu.test(imageId) ? imageId : "unknown";
  return `generated-image-gallery:${suffix}`;
}

function sanitizeImagePreviewCreatedAt(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const timestamp = value.trim();
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(timestamp)
  ) {
    return null;
  }
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function sanitizeRightDockImagePreviewImage(value: unknown): RightDockImagePreviewImage | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const id = sanitizeImagePreviewDisplayText(value.id) ?? "";
  const path = sanitizeLocalImagePath(value.path);
  if (id.length === 0 || path === null) {
    return null;
  }
  const name = sanitizeImagePreviewDisplayText(value.name);
  return {
    id,
    path,
    name: name ?? imagePreviewFallbackName(path),
  };
}

function sanitizeRightDockHtmlDocument(value: unknown): RightDockHtmlDocument | null {
  if (!isPlainObject(value) || typeof value.title !== "string") return null;
  const title = value.title.trim();
  if (title.length === 0 || title.length > 200 || title.includes("\u0000")) return null;
  if (value.kind === "html-render") {
    return typeof value.attachmentId === "string" && /^[a-z\d_-]{1,256}$/iu.test(value.attachmentId)
      ? { kind: "html-render", attachmentId: value.attachmentId, title }
      : null;
  }
  if (value.kind === "inline-visualization") {
    return typeof value.path === "string" &&
      value.path.length > 0 &&
      value.path.length <= 4096 &&
      !value.path.includes("\u0000")
      ? { kind: "inline-visualization", path: value.path, title }
      : null;
  }
  return null;
}

export function sanitizeRightDockImagePreviewState(
  value: unknown,
): RightDockImagePreviewState | null {
  if (
    !isPlainObject(value) ||
    (value.view !== "single" && value.view !== "playground") ||
    !Array.isArray(value.images)
  ) {
    return null;
  }

  const seenIds = new Set<string>();
  const images: RightDockImagePreviewImage[] = [];
  for (const rawImage of value.images) {
    const image = sanitizeRightDockImagePreviewImage(rawImage);
    if (!image || seenIds.has(image.id)) {
      continue;
    }
    seenIds.add(image.id);
    images.push(image);
  }
  if (images.length === 0) {
    return null;
  }

  const persistedActiveImageId =
    typeof value.activeImageId === "string" ? value.activeImageId.trim() : "";
  const activeImageId = seenIds.has(persistedActiveImageId)
    ? persistedActiveImageId
    : (images[0]?.id ?? null);
  if (activeImageId === null) {
    return null;
  }

  const cwd = sanitizeLocalImagePath(value.cwd);
  const conversationTitle = sanitizeImagePreviewDisplayText(value.conversationTitle);
  const fallbackGroupId = sanitizeImagePreviewGroupId(
    generatedImagePreviewFallbackGroupId(images[0]?.id),
  );
  const groupId =
    sanitizeImagePreviewGroupId(value.groupId) ??
    fallbackGroupId ??
    "generated-image-gallery:unknown";
  const createdAt = sanitizeImagePreviewCreatedAt(value.createdAt);
  return {
    images,
    activeImageId,
    cwd,
    conversationTitle,
    view: value.view,
    groupId,
    createdAt,
  };
}

// Persisted dock state predates the current pane-kind union, so a stale entry
// (e.g. a kind that was renamed or removed) can crash the dock during render.
// Drop any pane we no longer understand and keep the active tab pointing at a
// surviving pane.
function sanitizePersistedPane(value: unknown): RightDockPane | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const candidate = value;
  if (typeof candidate.id !== "string" || !isRightDockPaneKind(candidate.kind)) {
    return null;
  }
  const imagePreview =
    candidate.kind === "imagePreview"
      ? sanitizeRightDockImagePreviewState(candidate.imagePreview)
      : undefined;
  if (candidate.kind === "imagePreview" && imagePreview === null) {
    return null;
  }
  const htmlDocument =
    candidate.kind === "htmlRender"
      ? sanitizeRightDockHtmlDocument(candidate.htmlDocument)
      : undefined;
  if (candidate.kind === "htmlRender" && htmlDocument === null) return null;
  const imagePreviewField: { imagePreview?: RightDockImagePreviewState | null } =
    candidate.kind === "imagePreview" && imagePreview !== undefined ? { imagePreview } : {};
  const htmlDocumentField: { htmlDocument?: RightDockHtmlDocument } =
    candidate.kind === "htmlRender" && htmlDocument !== undefined && htmlDocument !== null
      ? { htmlDocument }
      : {};
  return {
    id: candidate.id,
    kind: candidate.kind,
    ...(candidate.kind === "canvas" && sanitizeMossCanvasImageFocus(candidate.canvasImage)
      ? { canvasImage: sanitizeMossCanvasImageFocus(candidate.canvasImage)! }
      : {}),
    threadId: typeof candidate.threadId === "string" ? (candidate.threadId as ThreadId) : null,
    subagentsSourceThreadId:
      typeof candidate.subagentsSourceThreadId === "string"
        ? (candidate.subagentsSourceThreadId as ThreadId)
        : null,
    subagentsSelectedThreadId:
      typeof candidate.subagentsSelectedThreadId === "string"
        ? (candidate.subagentsSelectedThreadId as ThreadId)
        : null,
    subagentsSelectedDisplayName:
      typeof candidate.subagentsSelectedDisplayName === "string"
        ? candidate.subagentsSelectedDisplayName
        : null,
    diffTurnId: typeof candidate.diffTurnId === "string" ? (candidate.diffTurnId as TurnId) : null,
    diffFilePath: typeof candidate.diffFilePath === "string" ? candidate.diffFilePath : null,
    filePath: typeof candidate.filePath === "string" ? candidate.filePath : null,
    ...(candidate.previewEntry === "attachment" ||
    candidate.previewEntry === "library-local" ||
    candidate.previewEntry === "library-cloud"
      ? { previewEntry: candidate.previewEntry }
      : {}),
    ...imagePreviewField,
    ...htmlDocumentField,
    pullRequestProjectId:
      typeof candidate.pullRequestProjectId === "string"
        ? (candidate.pullRequestProjectId as ProjectId)
        : null,
    pullRequestRepository:
      typeof candidate.pullRequestRepository === "string" ? candidate.pullRequestRepository : null,
    pullRequestNumber:
      typeof candidate.pullRequestNumber === "number" &&
      Number.isInteger(candidate.pullRequestNumber) &&
      candidate.pullRequestNumber > 0
        ? candidate.pullRequestNumber
        : null,
    pullRequestInitialTab:
      candidate.pullRequestInitialTab === "summary" ||
      candidate.pullRequestInitialTab === "timeline" ||
      candidate.pullRequestInitialTab === "code"
        ? candidate.pullRequestInitialTab
        : null,
  };
}

export function sanitizeRightDockThreadState(value: unknown): RightDockThreadState {
  if (!isPlainObject(value)) {
    return createDefaultRightDockState();
  }
  const candidate = value;
  const sanitizedPanes = Array.isArray(candidate.panes)
    ? candidate.panes
        .map(sanitizePersistedPane)
        .filter((pane): pane is RightDockPane => pane !== null)
    : [];
  const persistedActivePaneId =
    typeof candidate.activePaneId === "string" ? candidate.activePaneId : null;
  const keptSingletonPaneIdByKind = new Map<RightDockPaneKind, string>();
  for (const pane of sanitizedPanes) {
    if (
      isSingletonPaneKind(pane.kind) &&
      (pane.id === persistedActivePaneId || !keptSingletonPaneIdByKind.has(pane.kind))
    ) {
      keptSingletonPaneIdByKind.set(pane.kind, pane.id);
    }
  }
  const panes = sanitizedPanes.filter(
    (pane) =>
      !isSingletonPaneKind(pane.kind) || keptSingletonPaneIdByKind.get(pane.kind) === pane.id,
  );
  const activePaneId =
    persistedActivePaneId && panes.some((pane) => pane.id === persistedActivePaneId)
      ? persistedActivePaneId
      : (panes[0]?.id ?? null);
  return {
    open: candidate.open === true,
    panes,
    activePaneId,
  };
}

export function sanitizeRightDockStateByThreadId(
  value: unknown,
): Record<string, RightDockThreadState> {
  return sanitizeStringKeyedRecord(value, (raw) =>
    raw === undefined ? null : sanitizeRightDockThreadState(raw),
  );
}

export interface OpenPaneInput {
  canvasImage?: MossCanvasImageFocus;
  paneId: string;
  kind: RightDockPaneKind;
  threadId?: ThreadId | null;
  subagentsSourceThreadId?: ThreadId | null;
  subagentsSelectedThreadId?: ThreadId | null;
  subagentsSelectedDisplayName?: string | null;
  diffTurnId?: TurnId | null;
  diffFilePath?: string | null;
  filePath?: string | null;
  previewEntry?: CodexPreviewEntry;
  imagePreview?: RightDockImagePreviewState | null;
  htmlDocument?: RightDockHtmlDocument;
  pullRequestProjectId?: ProjectId | null;
  pullRequestRepository?: string | null;
  pullRequestNumber?: number | null;
  pullRequestInitialTab?: PullRequestInitialTab | null;
}

function createPane(input: OpenPaneInput): RightDockPane | null {
  const basePane = {
    id: input.paneId,
    kind: input.kind,
    ...(input.kind === "canvas" && sanitizeMossCanvasImageFocus(input.canvasImage)
      ? { canvasImage: sanitizeMossCanvasImageFocus(input.canvasImage)! }
      : {}),
    threadId: input.threadId ?? null,
    subagentsSourceThreadId: input.subagentsSourceThreadId ?? null,
    subagentsSelectedThreadId: input.subagentsSelectedThreadId ?? null,
    subagentsSelectedDisplayName: input.subagentsSelectedDisplayName ?? null,
    diffTurnId: input.diffTurnId ?? null,
    diffFilePath: input.diffFilePath ?? null,
    filePath: input.filePath ?? null,
    ...(input.previewEntry ? { previewEntry: input.previewEntry } : {}),
    ...(input.htmlDocument ? { htmlDocument: input.htmlDocument } : {}),
    pullRequestProjectId: input.pullRequestProjectId ?? null,
    pullRequestRepository: input.pullRequestRepository ?? null,
    pullRequestNumber: input.pullRequestNumber ?? null,
    pullRequestInitialTab: input.pullRequestInitialTab ?? null,
  };
  if (input.kind !== "imagePreview") {
    return basePane;
  }
  const imagePreview = sanitizeRightDockImagePreviewState(input.imagePreview);
  return imagePreview === null ? null : { ...basePane, imagePreview };
}

// Payload to merge into an existing singleton pane when re-opening it. Only
// overwrite content metadata when the caller explicitly targets new content,
// so a bare re-open/toggle keeps the pane focused on what it currently shows.
function singletonPaneReopenPatch(input: OpenPaneInput): Partial<RightDockPane> | null {
  if (input.kind === "canvas" && input.canvasImage !== undefined) {
    const canvasImage = sanitizeMossCanvasImageFocus(input.canvasImage);
    return canvasImage ? { canvasImage } : null;
  }
  if (input.kind === "sidechat" && input.threadId !== undefined) {
    return { threadId: input.threadId ?? null };
  }
  if (
    input.kind === "subagents" &&
    (input.subagentsSourceThreadId !== undefined ||
      input.subagentsSelectedThreadId !== undefined ||
      input.subagentsSelectedDisplayName !== undefined)
  ) {
    return {
      ...(input.subagentsSourceThreadId !== undefined
        ? { subagentsSourceThreadId: input.subagentsSourceThreadId ?? null }
        : {}),
      ...(input.subagentsSelectedThreadId !== undefined
        ? { subagentsSelectedThreadId: input.subagentsSelectedThreadId ?? null }
        : {}),
      ...(input.subagentsSelectedDisplayName !== undefined
        ? { subagentsSelectedDisplayName: input.subagentsSelectedDisplayName ?? null }
        : {}),
    };
  }
  if (
    input.kind === "diff" &&
    (input.diffTurnId !== undefined || input.diffFilePath !== undefined)
  ) {
    return { diffTurnId: input.diffTurnId ?? null, diffFilePath: input.diffFilePath ?? null };
  }
  if (
    input.kind === "pullRequest" &&
    (input.pullRequestProjectId !== undefined ||
      input.pullRequestRepository !== undefined ||
      input.pullRequestNumber !== undefined ||
      input.pullRequestInitialTab !== undefined)
  ) {
    return {
      pullRequestProjectId: input.pullRequestProjectId ?? null,
      pullRequestRepository: input.pullRequestRepository ?? null,
      pullRequestNumber: input.pullRequestNumber ?? null,
      pullRequestInitialTab: input.pullRequestInitialTab ?? null,
    };
  }
  if (input.kind === "imagePreview" && input.imagePreview !== undefined) {
    const imagePreview = sanitizeRightDockImagePreviewState(input.imagePreview);
    return imagePreview === null ? null : { imagePreview };
  }
  if (input.kind === "htmlRender" && input.htmlDocument !== undefined) {
    const htmlDocument = sanitizeRightDockHtmlDocument(input.htmlDocument);
    return htmlDocument === null ? null : { htmlDocument };
  }
  return null;
}

// Multi-instance file panes reuse an existing pane when it already shows the
// requested path, so re-clicking a file focuses its tab instead of duplicating it.
function findMatchingMultiInstancePane(
  state: RightDockThreadState,
  input: OpenPaneInput,
): RightDockPane | undefined {
  if (input.kind === "file") {
    const filePath = input.filePath ?? null;
    return state.panes.find(
      (pane) =>
        pane.kind === "file" &&
        pane.filePath === filePath &&
        (pane.previewEntry ?? "local") === (input.previewEntry ?? "local"),
    );
  }
  if (input.kind === "htmlRender") {
    const document = input.htmlDocument;
    return document
      ? state.panes.find(
          (pane) =>
            pane.kind === "htmlRender" &&
            pane.htmlDocument?.kind === document.kind &&
            (document.kind === "html-render"
              ? pane.htmlDocument?.kind === "html-render" &&
                pane.htmlDocument.attachmentId === document.attachmentId
              : pane.htmlDocument?.kind === "inline-visualization" &&
                pane.htmlDocument.path === document.path),
        )
      : undefined;
  }
  return undefined;
}

function findSingletonPane(
  state: RightDockThreadState,
  kind: RightDockPaneKind,
): RightDockPane | undefined {
  return state.panes.find((pane) => pane.kind === kind);
}

// Opens (or focuses) a pane and makes the dock visible. Singleton kinds reuse
// the existing pane and merge diff metadata; multi-instance kinds add a new
// pane unless one already shows the same content (thread / file).
export function openPaneInState(
  state: RightDockThreadState,
  input: OpenPaneInput,
): RightDockThreadState {
  if (isSingletonPaneKind(input.kind)) {
    const existing = findSingletonPane(state, input.kind);
    if (existing) {
      const patch = singletonPaneReopenPatch(input);
      const nextPanes = patch
        ? state.panes.map((pane) => (pane.id === existing.id ? { ...pane, ...patch } : pane))
        : state.panes;
      return { open: true, panes: nextPanes, activePaneId: existing.id };
    }
  } else {
    const existing = findMatchingMultiInstancePane(state, input);
    if (existing) {
      return { open: true, panes: state.panes, activePaneId: existing.id };
    }
  }

  const pane = createPane(input);
  if (pane === null) {
    return state;
  }
  return {
    open: true,
    panes: [...state.panes, pane],
    activePaneId: pane.id,
  };
}

function resolveActiveAfterRemoval(
  panes: RightDockPane[],
  removedIndex: number,
  previousActiveId: string | null,
  removedId: string,
): string | null {
  if (previousActiveId !== removedId) {
    return previousActiveId;
  }
  return resolveTabAfterClose(panes, removedIndex)?.id ?? null;
}

export function closePaneInState(
  state: RightDockThreadState,
  paneId: string,
): RightDockThreadState {
  const removedIndex = state.panes.findIndex((pane) => pane.id === paneId);
  if (removedIndex === -1) {
    return state;
  }
  const nextPanes = state.panes.filter((pane) => pane.id !== paneId);
  const nextActiveId = resolveActiveAfterRemoval(
    nextPanes,
    removedIndex,
    state.activePaneId,
    paneId,
  );
  return {
    // Match T3: an empty launcher is only shown when the user explicitly
    // opens the dock. Closing its final tab releases the transcript width.
    open: nextPanes.length > 0 && state.open,
    panes: nextPanes,
    activePaneId: nextActiveId,
  };
}

/** Drops a dragged tab onto another tab's slot; the active pane and the dock stay as they are. */
export function movePaneInState(
  state: RightDockThreadState,
  paneId: string,
  overPaneId: string,
): RightDockThreadState {
  const fromIndex = state.panes.findIndex((pane) => pane.id === paneId);
  const toIndex = state.panes.findIndex((pane) => pane.id === overPaneId);
  return fromIndex < 0 || toIndex < 0 || fromIndex === toIndex
    ? state
    : { ...state, panes: arrayMove(state.panes, fromIndex, toIndex) };
}

export function setActivePaneInState(
  state: RightDockThreadState,
  paneId: string,
): RightDockThreadState {
  if (!state.panes.some((pane) => pane.id === paneId)) {
    return state;
  }
  return { ...state, open: true, activePaneId: paneId };
}

export function setDockOpenInState(
  state: RightDockThreadState,
  open: boolean,
): RightDockThreadState {
  if (state.open === open) {
    return state;
  }
  return { ...state, open };
}

export function updatePaneInState(
  state: RightDockThreadState,
  paneId: string,
  patch: Partial<
    Pick<
      RightDockPane,
      | "diffTurnId"
      | "diffFilePath"
      | "filePath"
      | "htmlDocument"
      | "imagePreview"
      | "threadId"
      | "subagentsSourceThreadId"
      | "subagentsSelectedThreadId"
      | "subagentsSelectedDisplayName"
      | "pullRequestProjectId"
      | "pullRequestRepository"
      | "pullRequestNumber"
      | "pullRequestInitialTab"
    >
  >,
): RightDockThreadState {
  let changed = false;
  const nextPanes = state.panes.map((pane) => {
    if (pane.id !== paneId) {
      return pane;
    }
    let normalizedPatch = patch;
    if (Object.hasOwn(patch, "imagePreview")) {
      const imagePreview = sanitizeRightDockImagePreviewState(patch.imagePreview);
      if (imagePreview === null) {
        const patchWithoutImagePreview = { ...patch };
        Reflect.deleteProperty(patchWithoutImagePreview, "imagePreview");
        normalizedPatch = patchWithoutImagePreview;
      } else {
        normalizedPatch = { ...patch, imagePreview };
      }
    }
    if (Object.hasOwn(normalizedPatch, "htmlDocument")) {
      const htmlDocument = sanitizeRightDockHtmlDocument(normalizedPatch.htmlDocument);
      if (htmlDocument === null) {
        const patchWithoutHtmlDocument = { ...normalizedPatch };
        Reflect.deleteProperty(patchWithoutHtmlDocument, "htmlDocument");
        normalizedPatch = patchWithoutHtmlDocument;
      } else {
        normalizedPatch = { ...normalizedPatch, htmlDocument };
      }
    }
    const nextPane = { ...pane, ...normalizedPatch };
    if (
      nextPane.diffTurnId !== pane.diffTurnId ||
      nextPane.diffFilePath !== pane.diffFilePath ||
      nextPane.filePath !== pane.filePath ||
      nextPane.htmlDocument !== pane.htmlDocument ||
      nextPane.imagePreview !== pane.imagePreview ||
      nextPane.threadId !== pane.threadId ||
      nextPane.subagentsSourceThreadId !== pane.subagentsSourceThreadId ||
      nextPane.subagentsSelectedThreadId !== pane.subagentsSelectedThreadId ||
      nextPane.subagentsSelectedDisplayName !== pane.subagentsSelectedDisplayName ||
      nextPane.pullRequestProjectId !== pane.pullRequestProjectId ||
      nextPane.pullRequestRepository !== pane.pullRequestRepository ||
      nextPane.pullRequestNumber !== pane.pullRequestNumber ||
      nextPane.pullRequestInitialTab !== pane.pullRequestInitialTab
    ) {
      changed = true;
      return nextPane;
    }
    return pane;
  });
  return changed ? { ...state, panes: nextPanes } : state;
}

// Points the (singleton) side chat pane at another thread, or removes it for null, without
// opening or closing the dock. A host whose side chat follows a selection (the GitHub inbox)
// uses it so a closed dock stays closed and an open one shows the new target.
export function setSidechatPaneThreadInState(
  state: RightDockThreadState,
  input: { paneId: string; threadId: ThreadId | null },
): RightDockThreadState {
  const existing = findSingletonPane(state, "sidechat");
  if (input.threadId === null) {
    return existing ? closePaneInState(state, existing.id) : state;
  }
  if (existing) {
    return updatePaneInState(state, existing.id, { threadId: input.threadId });
  }
  const pane = createPane({ paneId: input.paneId, kind: "sidechat", threadId: input.threadId });
  if (pane === null) {
    return state;
  }
  return { open: state.open, panes: [...state.panes, pane], activePaneId: pane.id };
}

// Header toggles behave like a visibility switch for a singleton kind: if that
// kind is the active visible pane, collapse the dock (preserving tabs);
// otherwise open/focus it.
export function toggleSingletonPaneInState(
  state: RightDockThreadState,
  input: OpenPaneInput,
): RightDockThreadState {
  const existing = findSingletonPane(state, input.kind);
  if (existing && state.open && state.activePaneId === existing.id) {
    return { ...state, open: false };
  }
  return openPaneInState(state, input);
}

export function resolveActivePane(state: RightDockThreadState): RightDockPane | null {
  if (!state.open || state.activePaneId === null) {
    return null;
  }
  return state.panes.find((pane) => pane.id === state.activePaneId) ?? null;
}

export function findMissingSidechatPaneIds(
  state: RightDockThreadState,
  existingThreadIds: ReadonlySet<ThreadId>,
): readonly string[] {
  return state.panes.flatMap((pane) =>
    pane.kind === "sidechat" && pane.threadId && !existingThreadIds.has(pane.threadId)
      ? [pane.id]
      : [],
  );
}

// An active sidechat embeds a full chat, so it needs a detail lease just like a
// split-view pane. Persisted inactive or currently unrendered docks stay out of
// the scarce live-stream budget.
export function resolveVisibleDockSidechatThreadIds(input: {
  dockRendered: boolean;
  dockStateByThreadId: Record<string, RightDockThreadState | undefined>;
  hostThreadIds: readonly RightDockHostId[];
}): ThreadId[] {
  if (!input.dockRendered) {
    return [];
  }

  const sidechatThreadIds: ThreadId[] = [];
  const seenThreadIds = new Set<string>(input.hostThreadIds);
  for (const hostThreadId of input.hostThreadIds) {
    const dockState = input.dockStateByThreadId[hostThreadId];
    if (!dockState) {
      continue;
    }
    const activePane = resolveActivePane(dockState);
    if (
      activePane?.kind === "sidechat" &&
      activePane.threadId &&
      !seenThreadIds.has(activePane.threadId)
    ) {
      seenThreadIds.add(activePane.threadId);
      sidechatThreadIds.push(activePane.threadId);
    }
  }
  return sidechatThreadIds;
}
