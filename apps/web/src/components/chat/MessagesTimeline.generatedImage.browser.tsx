// FILE: MessagesTimeline.generatedImage.browser.tsx
// Purpose: Browser proof for the generated-image lifecycle, selected image and Canvas entry.
// Layer: Vitest browser tests

import "../../index.css";

import { MessageId, PROVIDER_SEND_TURN_MAX_ATTACHMENTS, ThreadId, TurnId } from "@synara/contracts";
import axe from "axe-core";
import { useCallback, useState, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { MossLocaleCode } from "../../appSettings";
import type { ComposerImageAttachment } from "../../composerDraftStore";
import { useComposerImageIntake } from "../../hooks/useComposerImageIntake";
import { useComposerDropzone } from "../../hooks/useComposerDropzone";
import { CHAT_FILE_REFERENCE_DRAG_TYPE } from "../../lib/chatReferences";
import { GENERATED_IMAGE_DRAG_TYPE } from "../../lib/generatedImageDrag";
import {
  registerGeneratedImageContextMenuOwner,
  showGeneratedImageContextMenu,
  type GeneratedImageContextLabels,
} from "../../lib/generatedImageContextMenu";
import { deriveTimelineEntries } from "../../session-logic";
import type { ChatMessage } from "../../types";
import type { TimelineEntry, WorkLogEntry } from "../../workLog";
import { GeneratedImagePreviewPane } from "./GeneratedImagePreviewPane";
import { GeneratedImageGallery } from "./GeneratedImageGallery";
import { MessagesTimeline } from "./MessagesTimeline";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const localizationTestState = vi.hoisted(() => ({ locale: "en" as MossLocaleCode }));
const imageFixtureState = vi.hoisted(() => ({
  makeUrl: (src: string) => {
    const wide = src.includes("wide");
    const width = wide ? 160 : 100;
    const height = wide ? 80 : 100;
    const color = src.includes("other") ? "#7c3aed" : "#2563eb";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${color}"/></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  },
}));

const CONTEXT_MENU_LABELS: GeneratedImageContextLabels = {
  addToChat: "Add to chat",
  copyImage: "Copy image",
  showInFileManager: "Show in Finder",
  downloadCopy: "Download a copy",
  addToChatError: "Could not add generated image to chat",
  copyError: "Could not copy generated image",
  showInFileManagerError: "Could not show generated image in the file manager",
  downloadError: "Could not download generated image",
};

const motionCommands = commands as unknown as {
  emulateReducedMotion: (reducedMotion: "reduce" | "no-preference") => Promise<void>;
};

vi.mock("~/localization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/localization")>();
  return {
    ...actual,
    useTranslation: () => ({
      locale: localizationTestState.locale,
      t: (key: Parameters<typeof actual.translateMoss>[1]) =>
        actual.translateMoss(localizationTestState.locale, key),
      format: (
        key: Parameters<typeof actual.formatMossTranslation>[1],
        values: Parameters<typeof actual.formatMossTranslation>[2],
      ) => actual.formatMossTranslation(localizationTestState.locale, key, values),
    }),
  };
});

vi.mock("~/lib/localImageUrls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/localImageUrls")>();
  return {
    ...actual,
    buildLocalImageUrl: (input: Parameters<typeof actual.buildLocalImageUrl>[0]) =>
      imageFixtureState.makeUrl(input.src),
  };
});

const TURN_ID = TurnId.makeUnsafe("generated-image-browser-turn");
const RECEIPT_DIR = "../../../../../.tmp/ui-parity/HEL-46-generated-image-context-menu";

function messageEntry(
  id: string,
  role: "user" | "assistant",
  text: string,
  createdAt: string,
  turnId?: TurnId,
): ChatMessage {
  return {
    id: MessageId.makeUnsafe(id),
    role,
    text,
    createdAt,
    streaming: false,
    ...(turnId ? { turnId } : {}),
  };
}

function generatedImageWorkEntry(input: {
  id: string;
  createdAt: string;
  path?: string;
  pending?: boolean;
  callId?: string;
  turnId?: TurnId;
}): WorkLogEntry {
  const callId = input.callId ?? input.id;
  const pending = input.pending === true;
  return {
    id: input.id,
    createdAt: input.createdAt,
    label: pending ? "Generating image" : "Generated image",
    tone: "tool",
    activityKind: pending ? "tool.started" : "tool.completed",
    itemType: "image_generation",
    ...(input.turnId ? { turnId: input.turnId } : {}),
    generatedImage: pending
      ? { state: "pending", callId }
      : { state: "completed", path: input.path ?? `/tmp/${input.id}.png`, callId },
  };
}

function timelineEntries(input: {
  images: ReadonlyArray<{ id: string; path?: string; pending?: boolean; callId?: string }>;
  assistantText?: string;
  assistant?: boolean;
  user?: boolean;
  turnId?: TurnId;
}): TimelineEntry[] {
  const turnId = input.turnId ?? TURN_ID;
  const messages: ChatMessage[] =
    input.user === false
      ? []
      : [messageEntry("generated-image-user", "user", "Make an image", "2026-08-28T00:00:00.000Z")];
  if (input.assistant !== false) {
    messages.push(
      messageEntry(
        "generated-image-assistant",
        "assistant",
        input.assistantText ?? "Done",
        "2026-08-28T00:00:04.000Z",
        turnId,
      ),
    );
  }
  const workEntries = input.images.map((image, index) =>
    generatedImageWorkEntry({
      id: image.id,
      createdAt: `2026-08-28T00:00:0${index + 1}.000Z`,
      ...(image.path ? { path: image.path } : {}),
      ...(image.pending !== undefined ? { pending: image.pending } : {}),
      ...(image.callId ? { callId: image.callId } : {}),
      turnId,
    }),
  );
  return deriveTimelineEntries(messages, [], workEntries);
}

function GeneratedImagePreviewTransitionHarness() {
  const [view, setView] = useState<"single" | "playground">("single");
  return (
    <GeneratedImagePreviewPane
      pane={{
        imagePreview: {
          images: [
            {
              id: "retry-timeout-image",
              path: "/tmp/retry-timeout-image.png",
              name: "retry-timeout-image.png",
            },
          ],
          activeImageId: "retry-timeout-image",
          cwd: null,
          conversationTitle: "Retry timeout",
          view,
        },
      }}
      onActiveImageChange={vi.fn()}
      onViewChange={setView}
    />
  );
}

function createHost(width: number, height = 520): HTMLDivElement {
  const dark = document.documentElement.classList.contains("dark");
  const host = document.createElement("div");
  host.style.cssText = [
    "box-sizing:border-box",
    `width:${width}px`,
    `max-width:${width}px`,
    `height:${height}px`,
    "overflow:hidden",
    "display:flex",
    "flex-direction:column",
    `padding:${width <= 390 ? "16px" : "24px"}`,
    `background:${dark ? "#0e0e0e" : "#f6f6f6"}`,
    `--background:${dark ? "#0e0e0e" : "#f6f6f6"}`,
    `--foreground:${dark ? "#f5f5f5" : "#202020"}`,
    `--muted-foreground:${dark ? "#c3c3c3" : "#616161"}`,
    `--secondary:${dark ? "#c2c2c2" : "#616161"}`,
    `--color-text-secondary:${dark ? "#c2c2c2" : "#616161"}`,
    `--color-background-primary-soft-active:${dark ? "color-mix(in srgb, var(--foreground) 12%, transparent)" : "color-mix(in srgb, var(--foreground) 8%, transparent)"}`,
    `--color-background-primary-ghost-hover:${dark ? "color-mix(in srgb, var(--foreground) 14%, transparent)" : "color-mix(in srgb, var(--foreground) 8%, transparent)"}`,
    `--color-border:${dark ? "#353535" : "#d0d0d0"}`,
    `--color-text-foreground:${dark ? "#f5f5f5" : "#202020"}`,
    `--color-text-foreground-secondary:${dark ? "#b9b9b9" : "#616161"}`,
    `--color-surface-elevated-secondary:${dark ? "#202020" : "#ffffff"}`,
  ].join(";");
  document.body.append(host);
  return host;
}

async function movePointerOutsideTestHost(): Promise<void> {
  await page.viewport(1_280, 800);
  const pointerSentinel = document.createElement("div");
  pointerSentinel.style.cssText = "position:fixed;left:1270px;top:790px;width:5px;height:5px;";
  document.body.append(pointerSentinel);
  await userEvent.hover(pointerSentinel);
  pointerSentinel.remove();
}

function setDarkBrowserTheme(): void {
  const values = {
    "--background": "#0e0e0e",
    "--foreground": "#f5f5f5",
    "--muted-foreground": "#9a9a9a",
    "--muted": "#242424",
    "--color-background-elevated-secondary": "#202020",
    "--color-surface-elevated-secondary": "#202020",
    "--color-border": "#3d3f41",
    "--color-border-heavy": "#626262",
    "--color-text-foreground": "#f5f5f5",
    "--color-text-foreground-secondary": "#c2c2c2",
    "--color-text-foreground-tertiary": "#9b9b9b",
    "--surface-border": "#3d3f41",
    "--ring": "#767676",
  } as const;
  for (const [name, value] of Object.entries(values)) {
    document.documentElement.style.setProperty(name, value);
  }
}

function GeneratedImageTimeline(props: {
  entries: TimelineEntry[];
  activeTurnInProgress?: boolean;
  activeTurnId?: TurnId;
  onImageExpand?: (preview: unknown) => void;
  onGeneratedImageContextMenu?: ComponentProps<
    typeof MessagesTimeline
  >["onGeneratedImageContextMenu"];
}) {
  // Upstream GeneratedMarkdownImage reads its grant state through react-query;
  // mount the timeline inside a provider so the markdown path can query.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={props.activeTurnInProgress ?? false}
        {...(props.activeTurnId ? { activeTurnId: props.activeTurnId } : {})}
        activeTurnStartedAt={props.activeTurnInProgress ? "2026-08-28T00:00:00.000Z" : null}
        timelineEntries={props.entries}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={props.onImageExpand ?? (() => {})}
        {...(props.onGeneratedImageContextMenu
          ? { onGeneratedImageContextMenu: props.onGeneratedImageContextMenu }
          : {})}
        markdownCwd={undefined}
        resolvedTheme={document.documentElement.classList.contains("dark") ? "dark" : "light"}
        timestampFormat="locale"
        workspaceRoot={undefined}
      />
    </QueryClientProvider>
  );
}

function GeneratedImageContextComposerHarness(props: {
  fixture: {
    provider: string;
    threadId: ThreadId;
    existingAttachmentCount?: number;
  };
  entries: TimelineEntry[];
  onImageExpand?: (preview: unknown) => void;
}) {
  const [images, setImages] = useState<ComposerImageAttachment[]>([]);
  const [intakeError, setIntakeError] = useState<string | null>(null);
  const [focusCount, setFocusCount] = useState(0);
  const initialAttachmentCount = props.fixture.existingAttachmentCount ?? 0;
  const existingAttachmentCount = useCallback(
    () => initialAttachmentCount + images.length,
    [images.length, initialAttachmentCount],
  );
  const commitImages = useCallback((prepared: ComposerImageAttachment[]) => {
    setImages((current) => [...current, ...prepared]);
    return prepared.length;
  }, []);
  const onIntakeError = useCallback((error: string | null) => {
    setIntakeError(error);
  }, []);
  const { addImages: enqueueComposerImages, isPreparingImages } = useComposerImageIntake({
    threadId: props.fixture.threadId,
    existingAttachmentCount,
    commitImages,
    onError: onIntakeError,
  });
  const onGeneratedImageContextMenu = useCallback<
    NonNullable<ComponentProps<typeof MessagesTimeline>["onGeneratedImageContextMenu"]>
  >(
    (image, event) => {
      void showGeneratedImageContextMenu({
        image,
        labels: CONTEXT_MENU_LABELS,
        position: { x: event.clientX, y: event.clientY },
        onAddToChat: (file) => enqueueComposerImages([file]),
        onFocusComposer: () => setFocusCount((count) => count + 1),
      });
    },
    [enqueueComposerImages],
  );

  return (
    <section
      data-testid={`generated-intake-${props.fixture.provider}`}
      data-intake-provider={props.fixture.provider}
      data-intake-thread={props.fixture.threadId}
      data-intake-attachment-count={initialAttachmentCount + images.length}
      data-intake-image-count={images.length}
      data-intake-focus-count={focusCount}
      data-intake-error={intakeError ?? undefined}
      data-intake-pending={isPreparingImages ? "true" : "false"}
    >
      <GeneratedImageTimeline
        entries={props.entries}
        {...(props.onImageExpand ? { onImageExpand: props.onImageExpand } : {})}
        onGeneratedImageContextMenu={onGeneratedImageContextMenu}
      />
      <span data-testid={`generated-intake-image-${props.fixture.provider}`}>
        {images.map((image) => `${image.name}:${image.mimeType}`).join(",")}
      </span>
    </section>
  );
}

function ComposerDropzoneProbe(props: {
  onImages: (files: readonly File[]) => void;
  onFocus: () => void;
  appendReferenceText?: (text: string) => void;
}) {
  const [isDragOver, setIsDragOver] = useState(false);
  const { onComposerDragEnter, onComposerDragLeave, onComposerDragOver, onComposerDrop } =
    useComposerDropzone({
      addImages: props.onImages,
      fileSupport: { genericFiles: "fallthrough" },
      appendReferenceText: props.appendReferenceText,
      focusComposer: props.onFocus,
      setIsDragOverComposer: setIsDragOver,
    });
  return (
    <div
      data-testid="generated-image-dropzone-probe"
      data-drag-over={isDragOver ? "true" : "false"}
      onDragEnter={onComposerDragEnter}
      onDragLeave={onComposerDragLeave}
      onDragOver={onComposerDragOver}
      onDrop={onComposerDrop}
    />
  );
}

async function blockingAxeViolations(root: Element = document.body) {
  const result = await axe.run(root);
  return result.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
}

function previewWidth(root: ParentNode): number {
  return (
    root.querySelector('[data-testid="generated-image-preview"]')?.getBoundingClientRect().width ??
    0
  );
}

async function expectLoadedImages(root: ParentNode = document): Promise<void> {
  const images = [...root.querySelectorAll<HTMLImageElement>("img")];
  await expect
    .poll(() => images.every((image) => image.complete && image.naturalWidth > 0))
    .toBe(true);
}

async function scrollIntoHostViewport(element: HTMLElement, host: HTMLElement): Promise<void> {
  element.scrollIntoView({ block: "center", inline: "nearest" });
  await expect
    .poll(() => {
      const elementRect = element.getBoundingClientRect();
      const hostRect = host.getBoundingClientRect();
      return (
        elementRect.width > 0 &&
        elementRect.height > 0 &&
        elementRect.bottom > hostRect.top &&
        elementRect.top < hostRect.bottom
      );
    })
    .toBe(true);
}

async function expectPendingCanvasEvidence(root: ParentNode): Promise<void> {
  const pending =
    root instanceof HTMLElement && root.matches('[data-testid="generated-image-pending"]')
      ? root
      : root.querySelector<HTMLElement>('[data-testid="generated-image-pending"]');
  const canvas = root.querySelector<HTMLCanvasElement>('[aria-busy="true"] canvas');
  if (!pending || !canvas) throw new Error("generated-image pending canvas is missing");
  await expect
    .poll(() => {
      const rect = pending.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || canvas.width <= 0 || canvas.height <= 0) {
        return false;
      }
      const context = canvas.getContext("2d");
      if (!context) return false;
      try {
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let index = 3; index < pixels.length; index += 4) {
          if ((pixels[index] ?? 0) > 0) return true;
        }
      } catch {
        return false;
      }
      return false;
    })
    .toBe(true);
}

describe("MessagesTimeline generated-image browser parity", () => {
  afterEach(async () => {
    // Move the browser pointer outside the next test host. Vitest keeps the
    // native pointer position between tests, so a later gallery mounted at the
    // same coordinates would otherwise incorrectly start in its hover state.
    await movePointerOutsideTestHost();
    await motionCommands.emulateReducedMotion("no-preference");
    localizationTestState.locale = "en";
    document.documentElement.classList.remove("dark");
    document.body.classList.remove("dark");
    document.documentElement.lang = "en";
    document.documentElement.removeAttribute("style");
    document.body.innerHTML = "";
  });

  it("renders one completed image after terminal markdown, suppresses compatibility markdown, and opens it", async () => {
    await page.viewport(720, 760);
    await motionCommands.emulateReducedMotion("no-preference");
    const host = createHost(720, 760);
    const onImageExpand = vi.fn();
    const screen = await render(
      <GeneratedImageTimeline
        entries={timelineEntries({
          images: [{ id: "one", path: "/tmp/generated-one.png" }],
          assistantText:
            "Here is the result.\n\n![Generated image](/tmp/generated-one.png)\n![Other](/tmp/other.png)",
          user: false,
        })}
        onImageExpand={onImageExpand}
      />,
      { container: host },
    );

    try {
      const gallery = page.getByTestId("generated-image-gallery");
      await expect.poll(() => (gallery.element() as HTMLElement).offsetHeight).toBeGreaterThan(0);
      expect(gallery.element().className).toContain("w-full");
      expect(previewWidth(gallery.element())).toBeLessThanOrEqual(480);
      expect(document.querySelector("[data-assistant-message-id]")).not.toBeNull();
      const preview = page.getByTestId("generated-image-preview");
      await expect.element(preview).toBeVisible();
      const previewImage = preview.element().querySelector<HTMLImageElement>("img");
      if (!previewImage) throw new Error("generated preview image is missing");
      expect(previewImage.getAttribute("alt")).toBe("Generated image 1");
      expect(previewImage.getAttribute("draggable")).toBe("true");
      expect(previewImage.getAttribute("referrerpolicy")).toBe("no-referrer");
      const transfer = new DataTransfer();
      const dragStart = new DragEvent("dragstart", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      });
      expect(previewImage.dispatchEvent(dragStart)).toBe(true);
      expect([...transfer.types]).toEqual([GENERATED_IMAGE_DRAG_TYPE]);
      const dragPayload = transfer.getData(GENERATED_IMAGE_DRAG_TYPE);
      expect(JSON.parse(dragPayload)).toEqual({
        dragId: expect.any(String),
        filename: "generated-image-1",
      });
      expect(dragPayload).not.toContain("/tmp/generated-one.png");
      expect(dragPayload).not.toContain("token");
      expect(dragPayload).not.toContain("src");
      expect(dragPayload).not.toContain("cwd");
      expect([...transfer.types]).not.toContain("text/plain");
      expect([...transfer.types]).not.toContain("text/uri-list");
      expect([...transfer.types]).not.toContain("DownloadURL");
      previewImage.dispatchEvent(
        new DragEvent("dragend", { bubbles: true, dataTransfer: transfer }),
      );
      expect(previewImage.className).toContain("image-transparency-backdrop");
      expect(
        preview.element().parentElement?.getAttribute("data-image-transparency-backdrop-scope"),
      ).toBe("");
      expect(document.querySelectorAll('img[alt="Generated image 1"]')).toHaveLength(1);
      await expectLoadedImages();
      expect(document.querySelector('[data-timeline-row-kind="work"]')).toBeNull();
      expect(document.body.textContent).not.toContain("Worked for");
      expect(document.body.textContent).toContain("Here is the result.");
      const unrelatedImage = document.querySelector<HTMLImageElement>('img[alt="Other"]');
      expect(unrelatedImage).not.toBeNull();
      await expect
        .poll(() => unrelatedImage?.complete === true && unrelatedImage.naturalWidth > 0)
        .toBe(true);
      await expect.element(page.getByAltText("Other")).toBeVisible();
      expect(document.body.textContent).not.toContain("(empty response)");
      await preview.click();
      expect(onImageExpand).toHaveBeenCalledWith(
        expect.objectContaining({
          index: 0,
          images: [expect.objectContaining({ name: "generated-one.png" })],
        }),
      );
      expect(await blockingAxeViolations()).toEqual([]);
      const screenshotPath = await page.screenshot({ path: `${RECEIPT_DIR}/light-single.png` });
      expect(screenshotPath).toContain("light-single.png");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("opens the four generated-image context actions without opening the image", async () => {
    await page.viewport(720, 520);
    const host = createHost(720);
    const onImageExpand = vi.fn();
    const addedImages: File[] = [];
    const onFocusComposer = vi.fn();
    const contextMenuItems = vi.fn();
    const delegatedContextEvents = vi.fn();
    const showContextMenu = vi.fn(async (items: readonly { id: string; label: string }[]) => {
      contextMenuItems(items);
      return "add-to-chat";
    });
    const onGeneratedImageContextMenu: NonNullable<
      ComponentProps<typeof MessagesTimeline>["onGeneratedImageContextMenu"]
    > = (image, event) => {
      expect(event.defaultPrevented).toBe(true);
      delegatedContextEvents(image);
      void showGeneratedImageContextMenu({
        image,
        labels: CONTEXT_MENU_LABELS,
        position: { x: event.clientX, y: event.clientY },
        onAddToChat: (file) => {
          addedImages.push(file);
        },
        onFocusComposer,
      });
    };
    const previousDesktopBridge = window.desktopBridge;
    const previousNativeApi = window.nativeApi;
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: {
        setTheme: vi.fn().mockResolvedValue(undefined),
        showContextMenu,
        getWsUrl: () => "ws://127.0.0.1:4321",
        clipboard: { writeImagePngDataUrl: vi.fn() },
        shell: { showInFolder: vi.fn() },
      },
    });
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: { contextMenu: { show: showContextMenu } },
    });
    const releasePreviewContextOwner = registerGeneratedImageContextMenuOwner(
      "generated-image-preview-thread",
      onGeneratedImageContextMenu,
    );
    const screen = await render(
      <>
        <GeneratedImageTimeline
          entries={timelineEntries({
            images: [{ id: "context-menu", path: "/tmp/generated-context-menu.png" }],
            assistantText: "Done\n\n![Other](/tmp/other-context-menu.png)",
            user: false,
          })}
          onImageExpand={onImageExpand}
          onGeneratedImageContextMenu={onGeneratedImageContextMenu}
        />
        <GeneratedImagePreviewPane
          pane={{
            imagePreview: {
              images: [
                {
                  id: "right-dock-context",
                  path: "/tmp/right-dock-context.png",
                  name: "right-dock-context.png",
                },
              ],
              activeImageId: "right-dock-context",
              cwd: null,
              conversationTitle: "Generated image context",
              view: "single",
            },
          }}
          threadId="generated-image-preview-thread"
          onActiveImageChange={vi.fn()}
        />
      </>,
      { container: host },
    );

    try {
      const preview = page.getByTestId("generated-image-preview");
      await expect.element(preview).toBeVisible();
      await expectLoadedImages(host);
      const markdownImage = host.querySelector<HTMLImageElement>('img[alt="Other"]');
      if (!markdownImage) throw new Error("generated markdown context image is missing");
      expect(
        markdownImage.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 18,
            clientY: 36,
          }),
        ),
      ).toBe(false);
      await expect.poll(() => delegatedContextEvents.mock.calls.length).toBe(1);
      expect(delegatedContextEvents.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({ src: "/tmp/other-context-menu.png" }),
      );
      await expect.poll(() => addedImages.length).toBe(1);
      const previewImage = preview.element().querySelector<HTMLImageElement>("img");
      if (!previewImage) throw new Error("generated context-menu image is missing");
      const contextEvent = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 42,
        clientY: 84,
      });
      expect(previewImage.dispatchEvent(contextEvent)).toBe(false);
      expect(onImageExpand).not.toHaveBeenCalled();
      await expect.poll(() => addedImages.length).toBe(2);
      expect(delegatedContextEvents.mock.calls[1]?.[0]).toEqual(
        expect.objectContaining({ src: "/tmp/generated-context-menu.png" }),
      );
      expect(addedImages[1]?.name).toBe("generated-context-menu.png");
      expect(addedImages[1]?.type).toBe("image/svg+xml");
      const previewPane = host.querySelector<HTMLElement>(
        '[data-testid="generated-image-preview-pane"]',
      );
      if (!previewPane) throw new Error("right-dock preview pane is missing");
      await expect.poll(() => previewPane.dataset.imageStatus).toBe("loaded");
      const beforeZoom = previewPane.dataset.imageZoomPercent;
      const beforeActiveImage = previewPane.dataset.imageId;
      const rightDockImage = previewPane.querySelector<HTMLImageElement>(
        'img[data-image-id="right-dock-context"]',
      );
      if (!rightDockImage) throw new Error("right-dock context image is missing");
      const rightDockContextEvent = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 96,
        clientY: 128,
      });
      expect(rightDockImage.dispatchEvent(rightDockContextEvent)).toBe(false);
      expect(onImageExpand).not.toHaveBeenCalled();
      await expect.poll(() => delegatedContextEvents.mock.calls.length).toBe(3);
      expect(delegatedContextEvents.mock.calls[2]?.[0]).toEqual(
        expect.objectContaining({ src: "/tmp/right-dock-context.png" }),
      );
      await expect.poll(() => addedImages.length).toBe(3);
      expect(previewPane.dataset.imageZoomPercent).toBe(beforeZoom);
      expect(previewPane.dataset.imageId).toBe(beforeActiveImage);
      expect(onFocusComposer).toHaveBeenCalledTimes(3);
      expect(contextMenuItems).toHaveBeenCalledWith([
        { id: "add-to-chat", label: "Add to chat" },
        { id: "copy-image", label: "Copy image" },
        { id: "open-in-file-manager", label: "Show in Finder" },
        { id: "download-a-copy", label: "Download a copy" },
      ]);
    } finally {
      await screen.unmount();
      host.remove();
      releasePreviewContextOwner();
      if (previousNativeApi === undefined) {
        delete window.nativeApi;
      } else {
        Object.defineProperty(window, "nativeApi", {
          configurable: true,
          value: previousNativeApi,
        });
      }
      if (previousDesktopBridge === undefined) {
        delete window.desktopBridge;
      } else {
        Object.defineProperty(window, "desktopBridge", {
          configurable: true,
          value: previousDesktopBridge,
        });
      }
    }
  });

  it("releases the shared-image transition lock when the target never gets a layout box", async () => {
    await page.viewport(720, 520);
    await motionCommands.emulateReducedMotion("no-preference");
    const host = createHost(720, 520);
    const screen = await render(<GeneratedImagePreviewTransitionHarness />, { container: host });
    const originalRect = Element.prototype.getBoundingClientRect;
    let targetRectReads = 0;
    let restoreImageRect: () => void = () => undefined;

    try {
      const pane = page.getByTestId("generated-image-preview-pane");
      await expect.element(pane).toBeVisible();
      await expectLoadedImages(host);
      const image = pane
        .element()
        .querySelector<HTMLImageElement>('img[data-image-id="retry-timeout-image"]');
      if (!image) throw new Error("retry-timeout image is missing");
      const imageRect = vi
        .spyOn(Element.prototype, "getBoundingClientRect")
        .mockImplementation(function (this: Element) {
          if (this instanceof HTMLImageElement && this.dataset.imageId === "retry-timeout-image") {
            targetRectReads += 1;
            return targetRectReads === 1 ? new DOMRect(0, 0, 100, 100) : new DOMRect(0, 0, 0, 0);
          }
          return originalRect.call(this);
        });
      restoreImageRect = () => imageRect.mockRestore();
      pane
        .element()
        .querySelector<HTMLButtonElement>('[data-testid="generated-image-preview-view-playground"]')
        ?.click();

      expect(pane.element().getAttribute("data-generated-image-preview-transitioning")).toBe(
        "true",
      );
      await new Promise((resolve) => window.setTimeout(resolve, 1_250));
      expect(targetRectReads).toBeGreaterThan(2);
      expect(pane.element().getAttribute("data-generated-image-preview-transitioning")).toBe(
        "false",
      );
      expect(pane.element().style.pointerEvents).toBe("");
    } finally {
      restoreImageRect();
      await screen.unmount();
      host.remove();
    }
  });

  it("routes Add to chat through normal intake for distinct provider threads", async () => {
    await page.viewport(920, 760);
    const host = createHost(920, 760);
    const contextMenuItems = vi.fn();
    const showContextMenu = vi.fn(async (items: readonly { id: string; label: string }[]) => {
      contextMenuItems(items);
      return "add-to-chat";
    });
    const previousDesktopBridge = window.desktopBridge;
    const previousNativeApi = window.nativeApi;
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: {
        setTheme: vi.fn().mockResolvedValue(undefined),
        showContextMenu,
        getWsUrl: () => "ws://127.0.0.1:4321",
        clipboard: { writeImagePngDataUrl: vi.fn() },
        shell: { showInFolder: vi.fn() },
      },
    });
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: { contextMenu: { show: showContextMenu } },
    });
    const screen = await render(
      <>
        <GeneratedImageContextComposerHarness
          fixture={{
            provider: "codex",
            threadId: ThreadId.makeUnsafe("context-codex-thread"),
            existingAttachmentCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1,
          }}
          entries={timelineEntries({
            images: [{ id: "context-codex", path: "/tmp/context-codex.png" }],
            user: false,
          })}
        />
        <GeneratedImageContextComposerHarness
          fixture={{
            provider: "claude",
            threadId: ThreadId.makeUnsafe("context-claude-thread"),
          }}
          entries={timelineEntries({
            images: [{ id: "context-claude", path: "/tmp/context-claude.png" }],
            user: false,
          })}
        />
      </>,
      { container: host },
    );

    try {
      await expectLoadedImages(host);
      const previews = [
        ...host.querySelectorAll<HTMLElement>('[data-testid="generated-image-preview"]'),
      ];
      expect(previews).toHaveLength(2);
      for (const preview of previews) {
        const previewImage = preview.querySelector<HTMLImageElement>("img");
        if (!previewImage) throw new Error("generated intake image is missing");
        expect(
          previewImage.dispatchEvent(
            new MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              clientX: 42,
              clientY: 84,
            }),
          ),
        ).toBe(false);
      }

      const codexIntake = host.querySelector<HTMLElement>('[data-testid="generated-intake-codex"]');
      const claudeIntake = host.querySelector<HTMLElement>(
        '[data-testid="generated-intake-claude"]',
      );
      if (!codexIntake || !claudeIntake) throw new Error("generated intake probes are missing");
      await expect.poll(() => codexIntake.getAttribute("data-intake-image-count")).toBe("1");
      await expect.poll(() => claudeIntake.getAttribute("data-intake-image-count")).toBe("1");
      expect(codexIntake.dataset.intakeProvider).toBe("codex");
      expect(codexIntake.dataset.intakeThread).toBe("context-codex-thread");
      expect(codexIntake.dataset.intakeAttachmentCount).toBe(
        String(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
      );
      expect(claudeIntake.dataset.intakeProvider).toBe("claude");
      expect(claudeIntake.dataset.intakeThread).toBe("context-claude-thread");
      expect(claudeIntake.dataset.intakeAttachmentCount).toBe("1");
      expect(host.querySelector('[data-testid="generated-intake-image-codex"]')?.textContent).toBe(
        "context-codex.png:image/svg+xml",
      );
      expect(host.querySelector('[data-testid="generated-intake-image-claude"]')?.textContent).toBe(
        "context-claude.png:image/svg+xml",
      );

      const codexImage = previews[0]?.querySelector<HTMLImageElement>("img");
      if (!codexImage) throw new Error("generated codex intake image is missing");
      expect(
        codexImage.dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
        ),
      ).toBe(false);
      await expect
        .poll(() => codexIntake.getAttribute("data-intake-error"))
        .toContain("attach up to");
      expect(codexIntake.dataset.intakeImageCount).toBe("1");
      expect(codexIntake.dataset.intakeFocusCount).toBe("2");
      expect(claudeIntake.dataset.intakeFocusCount).toBe("1");
      expect(contextMenuItems).toHaveBeenCalledTimes(3);
    } finally {
      await screen.unmount();
      host.remove();
      if (previousNativeApi === undefined) {
        delete window.nativeApi;
      } else {
        Object.defineProperty(window, "nativeApi", {
          configurable: true,
          value: previousNativeApi,
        });
      }
      if (previousDesktopBridge === undefined) {
        delete window.desktopBridge;
      } else {
        Object.defineProperty(window, "desktopBridge", {
          configurable: true,
          value: previousDesktopBridge,
        });
      }
    }
  });

  it("drops the private generated-image drag into the composer", async () => {
    await page.viewport(720, 520);
    const host = createHost(720);
    const onImages = vi.fn();
    const onFocus = vi.fn();
    const screen = await render(
      <>
        <GeneratedImageTimeline
          entries={timelineEntries({
            images: [{ id: "drop-source", path: "/tmp/drop-source.png" }],
            user: false,
          })}
        />
        <ComposerDropzoneProbe onImages={onImages} onFocus={onFocus} />
      </>,
      { container: host },
    );

    try {
      const preview = page.getByTestId("generated-image-preview");
      await expect.element(preview).toBeVisible();
      const previewImage = preview.element().querySelector<HTMLImageElement>("img");
      const dropzone = page.getByTestId("generated-image-dropzone-probe");
      if (!previewImage) throw new Error("generated preview image is missing");
      const transfer = new DataTransfer();
      previewImage.dispatchEvent(
        new DragEvent("dragstart", { bubbles: true, dataTransfer: transfer }),
      );
      const dragEnter = new DragEvent("dragenter", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      });
      expect(dropzone.element().dispatchEvent(dragEnter)).toBe(false);
      await expect.poll(() => dropzone.element().getAttribute("data-drag-over")).toBe("true");
      const dragOver = new DragEvent("dragover", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      });
      expect(dropzone.element().dispatchEvent(dragOver)).toBe(false);
      const drop = new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      });
      expect(dropzone.element().dispatchEvent(drop)).toBe(false);
      await expect.poll(() => onImages.mock.calls.length).toBe(1);
      const [files] = onImages.mock.calls[0] ?? [];
      expect(files).toHaveLength(1);
      expect(files?.[0]?.name).toBe("generated-image-1.svg");
      expect(files?.[0]?.type).toBe("image/svg+xml");
      expect(onFocus).toHaveBeenCalledTimes(1);
      await expect.poll(() => dropzone.element().getAttribute("data-drag-over")).toBe("false");
      previewImage.dispatchEvent(
        new DragEvent("dragend", { bubbles: true, dataTransfer: transfer }),
      );
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("cancels native image dragging when the private nonce cannot be created", async () => {
    await page.viewport(720, 520);
    const host = createHost(720);
    const screen = await render(
      <GeneratedImageTimeline
        entries={timelineEntries({
          images: [{ id: "failed-drag", path: "/tmp/failed-drag.png" }],
          user: false,
        })}
      />,
      { container: host },
    );

    try {
      const preview = page.getByTestId("generated-image-preview");
      await expect.element(preview).toBeVisible();
      const previewImage = preview.element().querySelector<HTMLImageElement>("img");
      if (!previewImage) throw new Error("generated preview image is missing");
      const transfer = new DataTransfer();
      const randomUUID = vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
        throw new Error("random UUID unavailable");
      });
      try {
        const dragStart = new DragEvent("dragstart", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        });
        expect(previewImage.dispatchEvent(dragStart)).toBe(false);
        expect([...transfer.types]).toEqual([]);
        expect(transfer.getData(GENERATED_IMAGE_DRAG_TYPE)).toBe("");
      } finally {
        randomUUID.mockRestore();
      }
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps file-reference and ordinary image drops on their existing branches", async () => {
    await page.viewport(720, 520);
    const host = createHost(720);
    const onImages = vi.fn();
    const onFocus = vi.fn();
    const onReference = vi.fn();
    const screen = await render(
      <ComposerDropzoneProbe
        onImages={onImages}
        onFocus={onFocus}
        appendReferenceText={onReference}
      />,
      { container: host },
    );

    try {
      const dropzone = page.getByTestId("generated-image-dropzone-probe");
      const referenceTransfer = new DataTransfer();
      referenceTransfer.setData(CHAT_FILE_REFERENCE_DRAG_TYPE, "@src/App.tsx");
      const referenceDrop = new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: referenceTransfer,
      });
      expect(dropzone.element().dispatchEvent(referenceDrop)).toBe(false);
      expect(onReference).toHaveBeenCalledWith("@src/App.tsx");
      expect(onImages).not.toHaveBeenCalled();

      const imageTransfer = new DataTransfer();
      imageTransfer.items.add(new File(["png"], "ordinary.png", { type: "image/png" }));
      const imageDrop = new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: imageTransfer,
      });
      expect(dropzone.element().dispatchEvent(imageDrop)).toBe(false);
      await expect.poll(() => onImages.mock.calls.length).toBe(1);
      const [files] = onImages.mock.calls[0] ?? [];
      expect(files).toHaveLength(1);
      expect(files?.[0]?.name).toBe("ordinary.png");
      expect(files?.[0]?.type).toBe("image/png");
      expect(onFocus).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps one large image and a 56px thumbnail rail inside a narrow conversation", async () => {
    await page.viewport(390, 620);
    document.documentElement.classList.add("dark");
    document.body.classList.add("dark");
    setDarkBrowserTheme();
    const host = createHost(390, 620);
    const onImageExpand = vi.fn();
    const screen = await render(
      <GeneratedImageTimeline
        entries={timelineEntries({
          images: Array.from({ length: 5 }, (_, index) => ({
            id: `image-${index + 1}`,
            path: `/tmp/generated-${index + 1}.png`,
          })),
        })}
        onImageExpand={onImageExpand}
      />,
      { container: host },
    );
    try {
      const gallery = page.getByTestId("generated-image-gallery");
      await expect
        .poll(() => gallery.element().getAttribute("data-gallery-layout"))
        .toBe("thumbnails");
      await expectLoadedImages(gallery.element());
      const preview = page.getByTestId("generated-image-preview");
      expect(
        gallery.element().querySelectorAll('[data-testid="generated-image-preview"]'),
      ).toHaveLength(1);
      const rail = page.getByTestId("generated-image-thumbnails").element();
      const thumbnails = [...rail.querySelectorAll<HTMLButtonElement>("button")];
      expect(thumbnails).toHaveLength(5);
      expect(thumbnails[0]?.getAttribute("aria-pressed")).toBe("true");
      expect(thumbnails[0]?.getBoundingClientRect().width).toBe(56);
      expect(thumbnails[0]?.getBoundingClientRect().height).toBe(56);
      expect(preview.element().getBoundingClientRect().width).toBeGreaterThan(150);
      expect(rail.getBoundingClientRect().left).toBeGreaterThan(
        preview.element().getBoundingClientRect().right,
      );
      expect(gallery.element().getBoundingClientRect().right).toBeLessThanOrEqual(
        host.getBoundingClientRect().right + 0.5,
      );
      await page.getByRole("button", { name: "Show generated image 3", exact: true }).click();
      expect(preview.element().getAttribute("data-image-id")).toBe("image-3");
      expect(thumbnails[2]?.getAttribute("aria-pressed")).toBe("true");
      expect(thumbnails[0]?.getAttribute("aria-pressed")).toBe("false");
      expect(onImageExpand).not.toHaveBeenCalled();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
      // This fixture's manually darkened page does not mount the app theme owner.
      // Audit the gallery itself, excluding the unrelated user-message palette.
      expect(await blockingAxeViolations(gallery.element())).toEqual([]);
      expect(await page.screenshot({ path: `${RECEIPT_DIR}/dark-390-thumbnails.png` })).toContain(
        "dark-390-thumbnails.png",
      );
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("reveals Canvas on hover and opens the selected group only when clicked", async () => {
    await page.viewport(720, 620);
    await movePointerOutsideTestHost();
    localizationTestState.locale = "zh-CN";
    const host = createHost(720, 620);
    const onImageExpand = vi.fn();
    const screen = await render(
      <GeneratedImageTimeline
        entries={timelineEntries({
          images: [
            { id: "one", path: "/tmp/one.png" },
            { id: "two", path: "/tmp/two.png" },
          ],
        })}
        onImageExpand={onImageExpand}
      />,
      { container: host },
    );
    try {
      const gallery = page.getByTestId("generated-image-gallery");
      await expectLoadedImages(gallery.element());
      const canvas = page.getByTestId("generated-image-open-canvas");
      await expect.poll(() => canvas.element().textContent).toContain("画布");
      const overlay = canvas.element().parentElement!;
      expect(getComputedStyle(overlay).opacity).toBe("0");
      await page.getByRole("button", { name: "显示生成的图片 2", exact: true }).click();
      const preview = page.getByTestId("generated-image-preview");
      await expectLoadedImages(gallery.element());
      await preview.hover();
      await expect.poll(() => getComputedStyle(canvas.element().parentElement!).opacity).toBe("1");
      expect(onImageExpand).not.toHaveBeenCalled();
      await canvas.click();
      expect(onImageExpand).toHaveBeenCalledTimes(1);
      expect(onImageExpand).toHaveBeenLastCalledWith(
        expect.objectContaining({
          index: 1,
          generated: expect.objectContaining({
            activeImageId: "two",
            initialView: "playground",
            groupId: TURN_ID,
            images: [
              expect.objectContaining({ id: "one", path: "/tmp/one.png" }),
              expect.objectContaining({ id: "two", path: "/tmp/two.png" }),
            ],
          }),
        }),
      );
      await preview.click();
      expect(onImageExpand).toHaveBeenCalledTimes(2);
      expect(onImageExpand.mock.calls[1]?.[0].generated).not.toHaveProperty("initialView");
      expect(
        await page.screenshot({ path: `${RECEIPT_DIR}/light-selected-canvas-hover.png` }),
      ).toContain("light-selected-canvas-hover.png");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("supports keyboard thumbnail selection and a focus-visible Canvas action without opening on navigation", async () => {
    await page.viewport(390, 620);
    const host = createHost(390, 620);
    const onImageExpand = vi.fn();
    const screen = await render(
      <GeneratedImageTimeline
        entries={timelineEntries({
          images: Array.from({ length: 5 }, (_, index) => ({ id: `key-${index}` })),
        })}
        onImageExpand={onImageExpand}
      />,
      { container: host },
    );
    try {
      const gallery = page.getByTestId("generated-image-gallery");
      await expectLoadedImages(gallery.element());
      const preview = page.getByTestId("generated-image-preview");
      (preview.element() as HTMLButtonElement).focus();
      const canvas = page.getByTestId("generated-image-open-canvas");
      await expect.poll(() => getComputedStyle(canvas.element().parentElement!).opacity).toBe("1");
      await userEvent.keyboard("{Tab}");
      expect(document.activeElement).toBe(canvas.element());
      await userEvent.keyboard("{Enter}");
      expect(onImageExpand).toHaveBeenCalledTimes(1);
      const first = page.getByRole("button", { name: "Show generated image 1", exact: true });
      (first.element() as HTMLButtonElement).focus();
      await userEvent.keyboard("{ArrowDown}");
      expect(preview.element().getAttribute("data-image-id")).toBe("key-1");
      expect(document.activeElement).toBe(
        page.getByRole("button", { name: "Show generated image 2", exact: true }).element(),
      );
      await userEvent.keyboard("{End}");
      expect(preview.element().getAttribute("data-image-id")).toBe("key-4");
      const rail = page.getByTestId("generated-image-thumbnails").element() as HTMLElement;
      await expect.poll(() => rail.scrollTop).toBeGreaterThan(0);
      const selected = document.activeElement!.getBoundingClientRect();
      expect(selected.bottom).toBeLessThanOrEqual(rail.getBoundingClientRect().bottom + 0.5);
      await userEvent.keyboard("{Home}{ArrowUp}");
      expect(preview.element().getAttribute("data-image-id")).toBe("key-0");
      await userEvent.keyboard(" ");
      expect(onImageExpand).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("preserves the selected identity as pending results complete and reorder", async () => {
    await page.viewport(720, 620);
    const host = createHost(720, 620);
    const onImageExpand = vi.fn();
    const first = { id: "first", path: "/tmp/shared.png" };
    const second = { id: "second", path: "/tmp/shared.png" };
    const third = { id: "third", path: "/tmp/wide-third.png" };
    const gallery = (
      images: Array<{ id: string; path: string }>,
      pendingImageCount: number,
      turnId = TURN_ID,
    ) => (
      <GeneratedImageGallery
        gallery={{ turnId, createdAt: "2026-10-14T00:00:00.000Z", images, pendingImageCount }}
        cwd="/tmp"
        onImageExpand={onImageExpand}
      />
    );
    const screen = await render(gallery([first], 2), { container: host });
    try {
      const preview = page.getByTestId("generated-image-preview");
      await expect.poll(() => preview.element().getAttribute("data-image-id")).toBe("first");
      expect(host.querySelectorAll('[data-testid="generated-image-pending"]')).toHaveLength(2);
      await screen.rerender(gallery([first, second], 1));
      expect(preview.element().getAttribute("data-image-id")).toBe("first");
      await page.getByRole("button", { name: "Show generated image 2", exact: true }).click();
      expect(preview.element().getAttribute("data-image-id")).toBe("second");
      await screen.rerender(gallery([third, second, first], 0));
      expect(preview.element().getAttribute("data-image-id")).toBe("second");
      expect(host.querySelectorAll('[data-testid="generated-image-pending"]')).toHaveLength(0);
      await preview.click();
      expect(onImageExpand).toHaveBeenLastCalledWith(
        expect.objectContaining({
          index: 1,
          generated: expect.objectContaining({
            activeImageId: "second",
            cwd: "/tmp",
            images: [third, second, first].map((image) => expect.objectContaining(image)),
          }),
        }),
      );
      await screen.rerender(gallery([third, second, first], 0, TurnId.makeUnsafe("another-turn")));
      expect(preview.element().getAttribute("data-image-id")).toBe("third");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("renders the reduced-motion pending dot-field for a pending-only active turn", async () => {
    await page.viewport(390, 720);
    await motionCommands.emulateReducedMotion("reduce");
    const host = createHost(390, 720);
    const screen = await render(
      <GeneratedImageTimeline
        entries={timelineEntries({
          images: [{ id: "pending-only", pending: true }],
          assistant: false,
        })}
        activeTurnInProgress
        activeTurnId={TURN_ID}
      />,
      { container: host },
    );

    try {
      const pending = page.getByTestId("generated-image-pending");
      await expect.element(pending).toBeVisible();
      await scrollIntoHostViewport(pending.element() as HTMLElement, host);
      const pendingPlaceholder = pending.element().querySelector<HTMLElement>("[aria-busy=true]");
      expect(pendingPlaceholder).not.toBeNull();
      expect(pendingPlaceholder?.getAttribute("aria-label")).toBe("Generating image...");
      expect(pendingPlaceholder?.querySelector("canvas")).not.toBeNull();
      const dots = pending
        .element()
        .querySelector<HTMLElement>(".moss-generated-image-pending-dots");
      expect(dots?.getAttribute("data-reduced-motion")).toBe("true");
      expect(dots ? getComputedStyle(dots).animationName : "").toBe("none");
      await expectPendingCanvasEvidence(pending.element());
      expect(document.querySelector('[data-timeline-row-kind="work"]')).toBeNull();
      expect(
        document.querySelector('[data-timeline-row-kind="generated-image-gallery"] h4'),
      ).not.toBeNull();
      const screenshotPath = await page.screenshot({ path: `${RECEIPT_DIR}/pending-reduced.png` });
      expect(screenshotPath).toContain("pending-reduced.png");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps a completed image and pending placeholder in one mixed gallery", async () => {
    await page.viewport(720, 520);
    await motionCommands.emulateReducedMotion("no-preference");
    const host = createHost(720);
    const screen = await render(
      <GeneratedImageTimeline
        entries={timelineEntries({
          images: [
            { id: "mixed-complete", path: "/tmp/mixed.png" },
            { id: "mixed-pending", pending: true },
          ],
        })}
        activeTurnInProgress
        activeTurnId={TURN_ID}
      />,
      { container: host },
    );

    try {
      const gallery = page.getByTestId("generated-image-gallery");
      await expect.poll(() => (gallery.element() as HTMLElement).offsetHeight).toBeGreaterThan(0);
      await scrollIntoHostViewport(gallery.element() as HTMLElement, host);
      expect(
        gallery.element().querySelectorAll('[data-testid="generated-image-preview"]'),
      ).toHaveLength(1);
      expect(
        gallery.element().querySelectorAll('[data-testid="generated-image-pending"]'),
      ).toHaveLength(1);
      expect(document.querySelectorAll('[data-timeline-row-kind="work"]')).toHaveLength(0);
      await expectLoadedImages(gallery.element());
      await expectPendingCanvasEvidence(gallery.element());
      const screenshotPath = await page.screenshot({ path: `${RECEIPT_DIR}/mixed.png` });
      expect(screenshotPath).toContain("mixed.png");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps thumbnail switching immediate under reduced-motion", async () => {
    await page.viewport(390, 620);
    await motionCommands.emulateReducedMotion("reduce");
    const host = createHost(390, 620);
    const screen = await render(
      <GeneratedImageTimeline
        entries={timelineEntries({
          images: [
            { id: "reduced-first", path: "/tmp/first.png" },
            { id: "reduced-second", path: "/tmp/wide-second.png" },
          ],
        })}
      />,
      { container: host },
    );
    try {
      const gallery = page.getByTestId("generated-image-gallery");
      await expectLoadedImages(gallery.element());
      await page.getByRole("button", { name: "Show generated image 2", exact: true }).click();
      const preview = page.getByTestId("generated-image-preview");
      expect(preview.element().getAttribute("data-image-id")).toBe("reduced-second");
      await expectLoadedImages(gallery.element());
      const image = preview.element().querySelector("img")!;
      await expect
        .poll(() => image.getBoundingClientRect().width / image.getBoundingClientRect().height)
        .toBeCloseTo(2, 2);
      expect(getComputedStyle(preview.element()).transitionDuration).toBe("0s");
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
