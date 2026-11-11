import "../../index.css";

import { ThreadId } from "@moss/contracts";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { useConversationImageComposer } from "~/lib/conversationImageComposer";
import { mossCanvasOcclusionRect } from "~/lib/mossCanvasOcclusion";
import { ComposerPromptEditor } from "../ComposerPromptEditor";
import { TooltipProvider } from "../ui/tooltip";
import type { MossCanvasWebSurface } from "../MossCanvasWebSurface";
import { ComposerImageAttachmentChip } from "./ComposerImageAttachmentChip";
import { ConversationImageWorkspace } from "./ConversationImageWorkspace";

const state = vi.hoisted(() => ({ isCurrent: () => true }));
vi.mock("~/lib/mossImagesAccountBoundary", () => ({
  isMossImagesAccountIdentityChange: () => false,
  useMossImagesAccountBoundary: () => ({
    key: "account-a",
    identityKey: "account-a",
    isCurrent: state.isCurrent,
  }),
}));
// Keep the real preview, flex layout, registered portal and composer controls.
// The inert frame isolates network/save operations while retaining browser geometry.
// Like the real Canvas (open-hoola-canvas mossHostBottomInset), it lifts its
// full-width bottom control above the area `occludedBy` covers.
vi.mock("../MossCanvasWebSurface", () => ({
  MossCanvasWebSurface: (props: ComponentProps<typeof MossCanvasWebSurface>) => {
    const frame = useRef<HTMLIFrameElement>(null);
    const { occludedBy, onImportStateChange } = props;
    useEffect(() => {
      onImportStateChange?.("ready");
    }, [onImportStateChange]);
    useEffect(() => {
      const target = frame.current;
      if (!target) return;
      const lift = () => {
        const control = target.contentDocument?.querySelector("button");
        if (!control) return;
        const frameRect = target.getBoundingClientRect();
        const cover = mossCanvasOcclusionRect(frameRect, occludedBy?.getBoundingClientRect());
        const inset =
          cover && cover.top < frameRect.height
            ? Math.ceil(frameRect.height - Math.max(0, cover.top)) + 8
            : 0;
        control.style.bottom = `${inset}px`;
      };
      lift();
      const observer = new ResizeObserver(lift);
      observer.observe(target);
      if (occludedBy) observer.observe(occludedBy);
      target.addEventListener("load", lift);
      return () => {
        observer.disconnect();
        target.removeEventListener("load", lift);
      };
    }, [occludedBy]);
    return (
      <div className="relative flex min-h-0 flex-1">
        <iframe
          ref={frame}
          title="Layout Canvas"
          className="absolute inset-0 h-full w-full"
          srcDoc={
            "<button style=\"position:fixed;bottom:0;left:0;width:100%;height:40px\" onclick=\"parent.postMessage('canvas-bottom-click','*')\">Original comment</button>"
          }
        />
      </div>
    );
  },
}));

const threadId = ThreadId.makeUnsafe("canvas-layout-thread");
const noop = () => {};

function ComposerPortal() {
  const host = useConversationImageComposer(threadId);
  const [draft, setDraft] = useState({ value: "", cursor: 0 });
  const [attached, setAttached] = useState(false);
  if (!host?.target) return null;
  return createPortal(
    <form data-chat-composer-form className="rounded-xl border bg-background p-3">
      {attached && (
        <ComposerImageAttachmentChip
          image={{
            type: "image",
            id: "user-image",
            name: "reference.png",
            mimeType: "image/png",
            sizeBytes: 5,
            previewUrl:
              "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'/%3E",
            file: new File(["image"], "reference.png", { type: "image/png" }),
          }}
          images={[]}
          nonPersisted={false}
          onExpandImage={noop}
          onRemoveImage={() => setAttached(false)}
        />
      )}
      <ComposerPromptEditor
        {...draft}
        terminalContexts={[]}
        disabled={false}
        placeholder="Layout prompt"
        onRemoveTerminalContext={noop}
        onPaste={noop}
        onChange={(value, cursor) => setDraft({ value, cursor })}
      />
      <button type="button" onClick={() => setAttached(true)}>
        Add reference
      </button>
    </form>,
    host.target,
  );
}

function Harness() {
  const [clicks, setClicks] = useState(0);
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.data === "canvas-bottom-click") setClicks((count) => count + 1);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, []);
  return (
    <TooltipProvider>
      <div style={{ height: "80vh", width: "100%" }}>
        <ConversationImageWorkspace
          threadId={threadId}
          pane={{ id: "canvas-layout-pane" }}
          canvasOnly
          fullWidth
          visible
          onViewChange={noop}
          onActiveImageChange={noop}
          onRequestFullWidth={noop}
          onClose={noop}
        />
      </div>
      <ComposerPortal />
      <output data-testid="canvas-bottom-clicks">{clicks}</output>
    </TooltipProvider>
  );
}

afterEach(cleanup);

describe("full-width Canvas composer layout", () => {
  it("floats the composer over a full-bleed Canvas and keeps its bottom controls reachable as the composer grows and the viewport changes", async () => {
    await page.viewport(1280, 900);
    await render(<Harness />);
    const frame = page.getByTitle("Layout Canvas");
    await expect.element(page.getByTestId("composer-editor")).toBeVisible();
    const frameElement = frame.element() as HTMLIFrameElement;
    const composer = document.querySelector<HTMLFormElement>("[data-chat-composer-form]")!;
    const bottomControl = () => frameElement.contentDocument?.querySelector("button") ?? null;
    await vi.waitFor(() => expect(bottomControl()).not.toBeNull());
    // The Canvas runs under the composer, and its bottom controls sit above it.
    const assertReachable = async () => {
      await vi.waitFor(() => {
        const canvasRect = frameElement.getBoundingClientRect();
        const composerRect = composer.getBoundingClientRect();
        const control = bottomControl()!.getBoundingClientRect();
        expect(canvasRect.height).toBeGreaterThan(40);
        expect(canvasRect.bottom).toBeGreaterThanOrEqual(composerRect.bottom - 1);
        expect(canvasRect.top + control.bottom).toBeLessThanOrEqual(composerRect.top + 1);
        expect(control.top).toBeGreaterThanOrEqual(0);
      });
    };
    await assertReachable();
    const initialHeight = composer.getBoundingClientRect().height;
    const initialControlBottom = bottomControl()!.getBoundingClientRect().bottom;
    await page
      .getByTestId("composer-editor")
      .fill("First line\nSecond line\nThird line\nFourth line");
    await page.getByRole("button", { name: "Add reference" }).click();
    await vi.waitFor(() =>
      expect(composer.getBoundingClientRect().height).toBeGreaterThan(initialHeight),
    );
    await assertReachable();
    expect(bottomControl()!.getBoundingClientRect().bottom).toBeLessThan(initialControlBottom);
    const control = bottomControl()!.getBoundingClientRect();
    await userEvent.click(frameElement, {
      position: { x: control.right - 24, y: control.top + control.height / 2 },
    });
    await expect.element(page.getByTestId("canvas-bottom-clicks")).toHaveTextContent("1");
    await page.viewport(760, 640);
    await assertReachable();
    await page.getByTestId("composer-editor").fill("Short prompt");
    await assertReachable();
  });
});
