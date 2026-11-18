// FILE: WorkspaceFilePreview.selection.browser.tsx
// Purpose: Browser regressions for the highlight -> "Add to Chat" flow in the
//          rendered-markdown preview (snippet references) and source view, including a
//          selection change that arrives after the pill is shown.
// Layer: Focused component integration tests

import "../index.css";

import type { NativeApi, ProjectReadFileResult } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { ChatFileReference } from "../lib/chatReferences";
import { WorkspaceFilePreview } from "./WorkspaceFilePreview";

const WORKSPACE_ROOT = "/Users/tester/project";
const MARKDOWN_PATH = "docs/handoff.md";
const MARKDOWN_CONTENTS = "# Handoff\n\n- Ship the **selection** toolbar\n- Then celebrate\n";

function installNativeApi(api: NativeApi): () => void {
  const previousDescriptor = Object.getOwnPropertyDescriptor(window, "nativeApi");
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: api,
  });
  return () => {
    if (previousDescriptor) {
      Object.defineProperty(window, "nativeApi", previousDescriptor);
    } else {
      Reflect.deleteProperty(window, "nativeApi");
    }
  };
}

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function loadedMarkdown(): ProjectReadFileResult {
  return {
    relativePath: MARKDOWN_PATH,
    contents: MARKDOWN_CONTENTS,
    truncated: false,
    version: `sha256:${"1".repeat(64)}`,
    encoding: "utf8",
    lineEnding: "lf",
  };
}

function selectNodeContentsAndRelease(node: Node): void {
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("window.getSelection() is unavailable");
  }
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
  const rect = range.getBoundingClientRect();
  node.dispatchEvent(
    new MouseEvent("mouseup", {
      bubbles: true,
      cancelable: true,
      clientX: rect.right,
      clientY: rect.bottom,
    }),
  );
}

/** The pill's button as a person meets it: by its name. */
const addToChatButton = () => page.getByRole("button", { name: "Add to Chat", exact: true });

/** The pill is on screen: visible, with a size, inside the viewport. */
async function expectAddToChatOnScreen(): Promise<void> {
  await expect.element(addToChatButton()).toBeVisible();
  const rect = addToChatButton().element().getBoundingClientRect();
  expect(rect.width).toBeGreaterThan(0);
  expect(rect.height).toBeGreaterThan(0);
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.top).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
  expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
}

const nextFrame = () =>
  new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));

function renderEditableMarkdownPreview(onReferenceInChat: (reference: ChatFileReference) => void) {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <WorkspaceFilePreview
        workspaceRoot={WORKSPACE_ROOT}
        filePath={MARKDOWN_PATH}
        markdownPreviewDefault
        editable
        onReferenceInChat={onReferenceInChat}
      />
    </QueryClientProvider>,
  );
}

function renderedList(): Element {
  const list = document.querySelector(".editor-markdown-preview ul");
  if (!list) {
    throw new Error("rendered markdown list not found");
  }
  return list;
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});

it("offers Add to Chat for an editable rendered-markdown selection", async () => {
  const readFile = vi.fn().mockResolvedValue(loadedMarkdown());
  const restoreNativeApi = installNativeApi({ projects: { readFile } } as unknown as NativeApi);
  const onReferenceInChat = vi.fn<(reference: ChatFileReference) => void>();

  try {
    await render(
      <QueryClientProvider client={makeQueryClient()}>
        <WorkspaceFilePreview
          workspaceRoot={WORKSPACE_ROOT}
          filePath={MARKDOWN_PATH}
          markdownPreviewDefault
          editable
          onReferenceInChat={onReferenceInChat}
        />
      </QueryClientProvider>,
    );

    await expect.element(page.getByRole("heading", { name: "Handoff" })).toBeVisible();
    const list = document.querySelector(".editor-markdown-preview ul");
    if (!list) {
      throw new Error("rendered markdown list not found");
    }

    selectNodeContentsAndRelease(list);

    await expectAddToChatOnScreen();
    await addToChatButton().click();

    expect(onReferenceInChat).toHaveBeenCalledTimes(1);
    expect(onReferenceInChat).toHaveBeenCalledWith({
      path: MARKDOWN_PATH,
      snippet: "Ship the selection toolbar\nThen celebrate",
    });
    // Committing removes the pill.
    await vi.waitFor(() => expect(addToChatButton().elements()).toHaveLength(0));
  } finally {
    restoreNativeApi();
  }
});

it("does not offer Add to Chat in the markdown preview without a chat target", async () => {
  const readFile = vi.fn().mockResolvedValue(loadedMarkdown());
  const restoreNativeApi = installNativeApi({ projects: { readFile } } as unknown as NativeApi);

  try {
    await render(
      <QueryClientProvider client={makeQueryClient()}>
        <WorkspaceFilePreview
          workspaceRoot={WORKSPACE_ROOT}
          filePath={MARKDOWN_PATH}
          markdownPreviewDefault
        />
      </QueryClientProvider>,
    );

    await expect.element(page.getByRole("heading", { name: "Handoff" })).toBeVisible();
    const list = document.querySelector(".editor-markdown-preview ul");
    if (!list) {
      throw new Error("rendered markdown list not found");
    }

    selectNodeContentsAndRelease(list);

    // Give the deferred selection read a frame to settle before asserting.
    await nextFrame();
    await nextFrame();
    expect(addToChatButton().elements()).toHaveLength(0);
  } finally {
    restoreNativeApi();
  }
});

// The browser delivers `selectionchange` as a task. On a busy or cold page the change for
// the selection a person just made arrives after the pill is already shown; the pill used
// to be cleared by it, so it appeared only some of the time (a 90 s timeout on the mirror).
it("keeps offering Add to Chat when the selection's own change arrives after the pill", async () => {
  const readFile = vi.fn().mockResolvedValue(loadedMarkdown());
  const restoreNativeApi = installNativeApi({ projects: { readFile } } as unknown as NativeApi);
  const onReferenceInChat = vi.fn<(reference: ChatFileReference) => void>();

  try {
    await renderEditableMarkdownPreview(onReferenceInChat);
    await expect.element(page.getByRole("heading", { name: "Handoff" })).toBeVisible();

    selectNodeContentsAndRelease(renderedList());
    await expectAddToChatOnScreen();

    // The same selection's change, delivered late.
    document.dispatchEvent(new Event("selectionchange"));
    await nextFrame();
    await nextFrame();
    await expectAddToChatOnScreen();

    await addToChatButton().click();
    expect(onReferenceInChat).toHaveBeenCalledExactlyOnceWith({
      path: MARKDOWN_PATH,
      snippet: "Ship the selection toolbar\nThen celebrate",
    });
  } finally {
    restoreNativeApi();
  }
});

it("follows a changed selection and goes when the selection is gone", async () => {
  const readFile = vi.fn().mockResolvedValue(loadedMarkdown());
  const restoreNativeApi = installNativeApi({ projects: { readFile } } as unknown as NativeApi);
  const onReferenceInChat = vi.fn<(reference: ChatFileReference) => void>();

  try {
    await renderEditableMarkdownPreview(onReferenceInChat);
    await expect.element(page.getByRole("heading", { name: "Handoff" })).toBeVisible();

    selectNodeContentsAndRelease(renderedList());
    await expectAddToChatOnScreen();

    // Narrowed to the last item (keyboard selection does not release a pointer): the pill
    // stays and adds what is selected now.
    const lastItem = renderedList().lastElementChild;
    if (!lastItem) throw new Error("rendered list item not found");
    const range = document.createRange();
    range.selectNodeContents(lastItem);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    await vi.waitFor(() => expect(addToChatButton().elements()).toHaveLength(1));
    await expectAddToChatOnScreen();
    await addToChatButton().click();
    expect(onReferenceInChat).toHaveBeenCalledExactlyOnceWith({
      path: MARKDOWN_PATH,
      snippet: "Then celebrate",
    });

    // A selection that is gone takes the pill with it.
    selectNodeContentsAndRelease(renderedList());
    await expectAddToChatOnScreen();
    window.getSelection()?.removeAllRanges();
    await vi.waitFor(() => expect(addToChatButton().elements()).toHaveLength(0));
  } finally {
    restoreNativeApi();
  }
});
