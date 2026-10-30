// @vitest-environment happy-dom
import React, { useEffect, type ComponentProps } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS, ThreadId } from "@synara/contracts";
import { useComposerDraftStore } from "~/composerDraftStore";
import { makeFile, makeImage, resetComposerDraftStore } from "~/composerDraftStoreTestFixtures";
import {
  flushConversationImageEditors,
  getConversationImageComposer,
} from "~/lib/conversationImageComposer";
import type { MossCanvasComposeContext, MossCanvasSelection } from "~/lib/mossCanvasSelection";
import type { MossCanvasBinding } from "~/lib/mossCanvasClient";
import { ConversationImageWorkspace } from "./ConversationImageWorkspace";
import type { MossCanvasWebSurface } from "../MossCanvasWebSurface";

const state = vi.hoisted(() => ({
  save: vi.fn<() => Promise<boolean>>(),
  read: vi.fn(),
  prepare: vi.fn(),
  readGenerated: vi.fn(),
  compose: vi.fn(),
  selection: null as MossCanvasSelection | null,
  current: true,
  key: "account-a",
  props: null as ComponentProps<typeof MossCanvasWebSurface> | null,
  isCurrent: () => state.current,
}));
vi.mock("~/lib/mossImagesAccountBoundary", () => ({
  useMossImagesAccountBoundary: () => ({
    key: state.key,
    transitioning: false,
    isCurrent: state.isCurrent,
  }),
}));
vi.mock("~/lib/mossCanvasClient", () => ({ readMossCanvasSelectionFile: state.read }));
vi.mock("~/lib/generatedImageContextMenu", () => ({
  readGeneratedImageContextFile: state.readGenerated,
}));
vi.mock("~/lib/composerSend", async (original) => ({
  ...(await original<typeof import("~/lib/composerSend")>()),
  prepareComposerImageAttachmentsFromFiles: state.prepare,
}));
vi.mock("./GeneratedImagePreviewPane", () => ({
  GeneratedImagePreviewPane: ({ canvasContent }: { canvasContent?: React.ReactNode }) => (
    <div>{canvasContent}</div>
  ),
}));
vi.mock("../MossCanvasWebSurface", () => ({
  MossCanvasWebSurface: (props: ComponentProps<typeof MossCanvasWebSurface>) => {
    state.props = props;
    useEffect(() => {
      props.onLeaveGuardChange?.(state.save);
      props.onImportStateChange?.("ready");
      props.onComposeContextChange?.(state.compose);
      return () => {
        props.onLeaveGuardChange?.(null);
        props.onComposeContextChange?.(null);
      };
    }, [props.onLeaveGuardChange, props.onImportStateChange, props.onComposeContextChange]);
    return <div>Original Hoola Canvas</div>;
  },
}));
const threadId = ThreadId.makeUnsafe("image-thread");
const props = {
  threadId,
  pane: { id: "image-pane" },
  canvasOnly: true,
  fullWidth: true,
  visible: true,
  onViewChange: vi.fn(),
  onActiveImageChange: vi.fn(),
  onRequestFullWidth: vi.fn(),
  onClose: vi.fn(),
};
const binding: MossCanvasBinding = {
  expectedAccount: { id: "a", realm: "cn" },
  expectedWorkspace: { threadId, fingerprint: "a".repeat(64) },
};
function select(sequence: number, names: string | readonly string[]) {
  const selection: MossCanvasSelection = {
    type: "moss-canvas-selection",
    version: 1,
    threadId,
    sequence,
    documentEpoch: 1,
    items: (typeof names === "string" ? [names] : names).map((name) => ({
      shapeId: `shape:${name}`,
      title: name,
      assetId: `moss-canvas-asset:${"a".repeat(64)}.png`,
    })),
  };
  state.selection = selection;
  state.props?.onSelectionChange?.(selection, binding);
}
function prepareImages({ files }: { files: readonly File[] }) {
  return {
    images: files.map((file) => ({
      type: "image" as const,
      id: crypto.randomUUID(),
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      previewUrl: "data:image/png;base64,aW1hZ2U=",
      file,
    })),
    error: null,
  };
}
beforeEach(() => {
  resetComposerDraftStore();
  state.current = true;
  state.key = "account-a";
  state.save.mockReset().mockResolvedValue(true);
  state.selection = null;
  state.compose.mockReset().mockImplementation(async () =>
    (await state.save())
      ? {
          binding,
          context: {
            type: "moss-canvas-compose-context-result",
            version: 1,
            threadId,
            requestId: "compose",
            documentEpoch: 1,
            selectionSequence: state.selection?.sequence ?? 1,
            ok: true,
            items: state.selection?.items ?? [],
          },
        }
      : null,
  );
  state.read
    .mockReset()
    .mockImplementation(
      async (item: { title: string }) =>
        new File(["image"], `${item.title}.png`, { type: "image/png" }),
    );
  state.readGenerated
    .mockReset()
    .mockResolvedValue(new File(["image"], "cat.png", { type: "image/png" }));
  state.prepare.mockReset().mockImplementation(async (input) => prepareImages(input));
});
afterEach(cleanup);

describe("original canvas and ordinary conversation composer", () => {
  it("reuses an existing user image without claiming or clearing its ownership", async () => {
    const userImage = makeImage({
      id: "user-cat",
      name: "cat.png",
      sizeBytes: 5,
      previewUrl: "data:image/png;base64,aW1hZ2U=",
    });
    useComposerDraftStore.getState().addImages(threadId, [userImage]);
    useComposerDraftStore.getState().setPrompt(threadId, "keep my image and text");
    const view = render(<ConversationImageWorkspace {...props} />);
    await act(async () => select(1, "cat"));
    let accepted = false;
    await act(async () => {
      accepted = await getConversationImageComposer(threadId)!.beforeSend();
    });
    expect(accepted).toBe(true);
    expect(view.queryByText("图片数量超过当前会话可接收的上限。")).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.images).toEqual([
      userImage,
    ]);

    await act(async () => select(2, "edited"));
    await waitFor(() =>
      expect(
        useComposerDraftStore
          .getState()
          .draftsByThreadId[threadId]?.images.map((image) => image.name),
      ).toEqual(["cat.png", "edited.png"]),
    );
    state.current = false;
    state.key = "account-b";
    view.rerender(<ConversationImageWorkspace {...props} />);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.images).toEqual([
      userImage,
    ]);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(
      "keep my image and text",
    );
  });

  it("accepts an existing reference at full capacity and rejects a genuinely ninth image", async () => {
    const userImages = Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS }, (_, index) =>
      makeImage({
        id: `user-${index}`,
        name: `user-${index}.png`,
        sizeBytes: 5,
        previewUrl: "data:image/png;base64,aW1hZ2U=",
      }),
    );
    useComposerDraftStore.getState().addImages(threadId, userImages);
    useComposerDraftStore.getState().setPrompt(threadId, "keep all eight");
    const view = render(<ConversationImageWorkspace {...props} />);
    await act(async () => select(1, "user-0"));
    let accepted = false;
    await act(async () => {
      accepted = await getConversationImageComposer(threadId)!.beforeSend();
    });
    expect(accepted).toBe(true);
    expect(view.queryByText("图片数量超过当前会话可接收的上限。")).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.images).toEqual(userImages);

    await act(async () => select(2, "ninth"));
    await view.findByText("图片数量超过当前会话可接收的上限。");
    expect(await getConversationImageComposer(threadId)!.beforeSend()).toBe(false);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.images).toEqual(userImages);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(
      "keep all eight",
    );
  });

  it("keeps the previous selection and user references when another attachment wins capacity during preparation", async () => {
    const userImages = Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 2 }, (_, index) =>
      makeImage({
        id: `user-${index}`,
        name: `user-${index}.png`,
        previewUrl: "data:image/png;base64,aW1hZ2U=",
      }),
    );
    useComposerDraftStore.getState().addImages(threadId, userImages);
    useComposerDraftStore.getState().setPrompt(threadId, "keep my draft");
    const view = render(<ConversationImageWorkspace {...props} />);
    await act(async () => select(1, "previous"));
    await waitFor(() =>
      expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.images).toHaveLength(
        PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1,
      ),
    );
    const previousImages = useComposerDraftStore.getState().draftsByThreadId[threadId]!.images;
    let release!: () => void;
    const preparation = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.prepare.mockImplementationOnce(async (input) => {
      await preparation;
      return prepareImages(input);
    });
    act(() => select(2, ["next-a", "next-b"]));
    await waitFor(() => expect(state.prepare).toHaveBeenCalledTimes(2));
    const otherFile = makeFile({ id: "last-slot", name: "keep.txt" });
    expect(useComposerDraftStore.getState().addFiles(threadId, [otherFile])).toBe(1);
    await act(async () => release());
    await view.findByText("图片数量超过当前会话可接收的上限。");
    expect(await getConversationImageComposer(threadId)!.beforeSend()).toBe(false);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.images).toEqual(
      previousImages,
    );
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.files).toEqual([otherFile]);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(
      "keep my draft",
    );

    state.current = false;
    state.key = "account-b";
    view.rerender(<ConversationImageWorkspace {...props} />);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.images).toEqual(userImages);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.files).toEqual([otherFile]);
  });

  it("counts a pending persisted image when deciding whether the new selection fits", async () => {
    const store = useComposerDraftStore.getState();
    store.addImages(
      threadId,
      Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1 }, (_, index) =>
        makeImage({
          id: `user-${index}`,
          name: `user-${index}.png`,
          previewUrl: "data:image/png;base64,aW1hZ2U=",
        }),
      ),
    );
    // A restored persisted attachment consumes a slot before its File hydrates.
    useComposerDraftStore.setState((state) => ({
      draftsByThreadId: {
        ...state.draftsByThreadId,
        [threadId]: {
          ...state.draftsByThreadId[threadId]!,
          persistedAttachments: [
            {
              id: "pending-image",
              name: "pending.png",
              mimeType: "image/png",
              sizeBytes: 2,
              dataUrl: "data:image/png;base64,aGk=",
            },
          ],
        },
      },
    }));
    const previousDraft = useComposerDraftStore.getState().draftsByThreadId[threadId]!;
    const view = render(<ConversationImageWorkspace {...props} />);
    await act(async () => select(1, "ninth"));
    await view.findByText("图片数量超过当前会话可接收的上限。");
    expect(await getConversationImageComposer(threadId)!.beforeSend()).toBe(false);
    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId]!;
    expect(draft.images).toEqual(previousDraft.images);
    expect(draft.persistedAttachments).toEqual(previousDraft.persistedAttachments);
  });

  it("restores the focused image reference for a follow-up after a previous send clears attachments", async () => {
    render(
      <ConversationImageWorkspace
        {...props}
        canvasOnly={false}
        pane={{
          id: "image-pane",
          imagePreview: {
            cwd: null,
            conversationTitle: "cat",
            view: "single",
            activeImageId: "cat",
            images: [{ id: "cat", path: "/outputs/cat.png", name: "cat.png" }],
          },
        }}
      />,
    );
    await waitFor(() =>
      expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.images).toHaveLength(1),
    );
    let accepted = false;
    await act(async () => {
      accepted = await getConversationImageComposer(threadId)!.beforeSend();
    });
    expect(accepted).toBe(true);
    const store = useComposerDraftStore.getState();
    for (const image of store.draftsByThreadId[threadId]!.images)
      store.removeImage(threadId, image.id);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.images ?? []).toHaveLength(
      0,
    );
    await act(async () => {
      accepted = await getConversationImageComposer(threadId)!.beforeSend();
    });
    expect(accepted).toBe(true);
    expect(
      useComposerDraftStore
        .getState()
        .draftsByThreadId[threadId]!.images.map((image) => image.name),
    ).toEqual(["cat.png"]);
  });
  it("uses the selected variant in the owning draft and blocks send/close when save fails", async () => {
    render(<ConversationImageWorkspace {...props} />);
    await act(async () => {
      select(1, "edited");
    });
    await waitFor(() =>
      expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.images[0]?.name).toBe(
        "edited.png",
      ),
    );
    expect(getConversationImageComposer(threadId)?.target).not.toBeNull();
    state.save.mockResolvedValue(false);
    expect(await getConversationImageComposer(threadId)!.beforeSend()).toBe(false);
    expect(await flushConversationImageEditors(threadId, props.pane.id)).toBe(false);
  });
  it("rejects a send if the selected image changes while the canvas is flushing", async () => {
    render(<ConversationImageWorkspace {...props} />);
    await act(async () => {
      select(1, "first");
    });
    let resolveSave!: (ok: boolean) => void;
    state.save.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const pending = getConversationImageComposer(threadId)!.beforeSend();
    await waitFor(() => expect(state.save).toHaveBeenCalled());
    await act(async () => {
      select(2, "second");
    });
    resolveSave(true);
    expect(await pending).toBe(false);
    expect(
      useComposerDraftStore
        .getState()
        .draftsByThreadId[threadId]?.images.map((image) => image.name),
    ).toEqual(["second.png"]);
  });
  it("drops late image preparation after an account change and clears only canvas references", async () => {
    const view = render(<ConversationImageWorkspace {...props} />);
    await act(async () => {
      select(1, "first");
    });
    useComposerDraftStore.getState().setPrompt(threadId, "keep my text");
    let release!: (file: File) => void;
    state.read.mockImplementation(
      () =>
        new Promise<File>((resolve) => {
          release = resolve;
        }),
    );
    act(() => select(2, "late"));
    state.current = false;
    state.key = "account-b";
    view.rerender(<ConversationImageWorkspace {...props} />);
    await act(async () => release(new File(["old"], "late.png", { type: "image/png" })));
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.images).toHaveLength(0);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(
      "keep my text",
    );
    expect(await getConversationImageComposer(threadId)!.beforeSend()).toBe(false);
  });
  it("sends the real annotated asset and bounded comments through existing attachments, preserving the prompt", async () => {
    render(<ConversationImageWorkspace {...props} />);
    await act(async () => {
      select(1, "cat");
    });
    useComposerDraftStore.getState().setPrompt(threadId, "按评论修改");
    const context: MossCanvasComposeContext = {
      type: "moss-canvas-compose-context-result",
      version: 1,
      threadId,
      requestId: "context",
      documentEpoch: 1,
      selectionSequence: 1,
      ok: true,
      items: [
        {
          ...state.selection!.items[0]!,
          context: {
            truncated: false,
            annotationAssetId: `moss-canvas-asset:${"b".repeat(64)}.png`,
            annotations: [{ kind: "draw", x: 0.1, y: 0.2, width: 0.2, height: 0.2 }],
            comments: [
              {
                text: "</pasted_text> 请保留毛发",
                region: { x: 0.2, y: 0.2, width: 0.1, height: 0.1 },
              },
            ],
          },
        },
      ],
    };
    state.compose.mockResolvedValue({ context, binding });
    let accepted = false;
    await act(async () => {
      accepted = await getConversationImageComposer(threadId)!.beforeSend();
    });
    expect(accepted).toBe(true);
    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId]!;
    expect(draft.prompt).toBe("按评论修改");
    expect(draft.images.map((image) => image.name)).toEqual(["cat.png", "cat — 标注.png"]);
    expect(draft.pastedTexts).toHaveLength(1);
    expect(
      JSON.parse(draft.pastedTexts[0]!.text.split("\n").slice(1).join("\n"))[0].comments[0].text,
    ).toBe("</pasted_text> 请保留毛发");
    expect(draft.pastedTexts[0]!.text).not.toContain("token=");
    await act(async () => {
      await getConversationImageComposer(threadId)!.beforeSend();
    });
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]!.pastedTexts).toHaveLength(
      1,
    );
  });
  it("preserves drafts and blocks truncated or failed annotation context", async () => {
    render(<ConversationImageWorkspace {...props} />);
    await act(async () => {
      select(1, "cat");
    });
    useComposerDraftStore.getState().setPrompt(threadId, "keep this");
    state.compose.mockResolvedValue({
      binding,
      context: {
        items: [
          {
            ...state.selection!.items[0]!,
            context: { annotations: [], comments: [], truncated: true },
          },
        ],
      },
    });
    expect(await getConversationImageComposer(threadId)!.beforeSend()).toBe(false);
    state.compose.mockRejectedValue(new Error("export failed"));
    expect(await getConversationImageComposer(threadId)!.beforeSend()).toBe(false);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]!.prompt).toBe("keep this");
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]!.images).toHaveLength(1);
  });
});
