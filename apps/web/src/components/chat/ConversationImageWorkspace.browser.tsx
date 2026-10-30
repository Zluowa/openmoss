import "../../index.css";

import { ThreadId } from "@synara/contracts";
import { useEffect, useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { useConversationImageComposer } from "~/lib/conversationImageComposer";
import { ComposerPromptEditor } from "../ComposerPromptEditor";
import { TooltipProvider } from "../ui/tooltip";
import type { MossCanvasWebSurface } from "../MossCanvasWebSurface";
import { ComposerImageAttachmentChip } from "./ComposerImageAttachmentChip";
import { ConversationImageWorkspace } from "./ConversationImageWorkspace";

const state = vi.hoisted(() => ({ isCurrent: () => true }));
vi.mock("~/lib/mossImagesAccountBoundary", () => ({
  useMossImagesAccountBoundary: () => ({ key: "account-a", isCurrent: state.isCurrent }),
}));
// Keep the real preview, flex layout, registered portal and composer controls.
// The inert frame isolates network/save operations while retaining browser geometry.
vi.mock("../MossCanvasWebSurface", () => ({
  MossCanvasWebSurface: (props: ComponentProps<typeof MossCanvasWebSurface>) => {
    useEffect(() => {
      props.onImportStateChange?.("ready");
    }, [props.onImportStateChange]);
    return (
      <div className="relative flex min-h-0 flex-1">
        <iframe
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
  it("keeps original bottom controls reachable as the registered composer grows and the viewport changes", async () => {
    await page.viewport(1280, 900);
    await render(<Harness />);
    const frame = page.getByTitle("Layout Canvas");
    await expect.element(page.getByTestId("composer-editor")).toBeVisible();
    const frameElement = frame.element() as HTMLIFrameElement;
    const composer = document.querySelector<HTMLFormElement>("[data-chat-composer-form]")!;
    const assertSeparate = async () => {
      await vi.waitFor(() => {
        const canvasRect = frameElement.getBoundingClientRect();
        const composerRect = composer.getBoundingClientRect();
        expect(canvasRect.height).toBeGreaterThan(40);
        expect(canvasRect.bottom).toBeLessThanOrEqual(composerRect.top + 1);
      });
    };
    await assertSeparate();
    const initialHeight = composer.getBoundingClientRect().height;
    const initialCanvasHeight = frameElement.getBoundingClientRect().height;
    await page
      .getByTestId("composer-editor")
      .fill("First line\nSecond line\nThird line\nFourth line");
    await page.getByRole("button", { name: "Add reference" }).click();
    await vi.waitFor(() =>
      expect(composer.getBoundingClientRect().height).toBeGreaterThan(initialHeight),
    );
    await assertSeparate();
    expect(frameElement.getBoundingClientRect().height).toBeLessThan(initialCanvasHeight);
    await vi.waitFor(() =>
      expect(frameElement.contentDocument?.querySelector("button")).not.toBeNull(),
    );
    const rect = frameElement.getBoundingClientRect();
    await userEvent.click(frameElement, { position: { x: rect.width - 24, y: rect.height - 20 } });
    await expect.element(page.getByTestId("canvas-bottom-clicks")).toHaveTextContent("1");
    await page.viewport(760, 640);
    await assertSeparate();
    await page.getByTestId("composer-editor").fill("Short prompt");
    await assertSeparate();
  });
});
