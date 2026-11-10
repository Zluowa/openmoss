import "../../index.css";

import { ThreadId } from "@moss/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { TurnChatArtifact } from "~/lib/chatArtifacts";
import { SharedViewerContext } from "~/lib/sharedViewer";
import { WorkspaceFileOpenerContext, type WorkspaceFileOpener } from "~/lib/workspaceFileOpener";
import { MossLocaleScope } from "~/localization";
import { useRightDockStore } from "~/rightDockStore";
import { ChatArtifactCards } from "./ChatArtifactCards";

const THREAD = "thread-cards";

const artifacts: TurnChatArtifact[] = [
  {
    id: "deck-activity",
    artifact: {
      kind: "deck",
      deck: {
        pageId: "page-1",
        scopeSpaceId: null,
        title: "2026 第三季度回顾",
        slideCount: 8,
        coverText: "2026 第三季度回顾 · 产品与增长",
        change: "created",
      },
    },
  },
  {
    id: "file-activity",
    artifact: {
      kind: "file",
      file: {
        file: "out/2026 第三季度回顾.pptx",
        name: "2026 第三季度回顾.pptx",
        path: "C:/work/out/2026 第三季度回顾.pptx",
        bytes: 1_258_291,
        sha256: "c".repeat(64),
      },
    },
  },
  {
    id: "zip-activity",
    artifact: {
      kind: "file",
      file: { file: "素材.zip", name: "素材.zip", path: null, bytes: null, sha256: null },
    },
  },
];

function Cards(props: { opener?: WorkspaceFileOpener; shared?: boolean; answer?: string }) {
  return (
    <MossLocaleScope locale="zh-CN">
      <SharedViewerContext.Provider value={props.shared ?? false}>
        <WorkspaceFileOpenerContext.Provider value={props.opener ?? null}>
          <div
            // The app's theme sets this token at runtime; give the test the light theme's value.
            style={{
              width: 560,
              padding: 16,
              ["--color-border-light" as string]: "rgba(26, 28, 31, 0.049)",
            }}
          >
            <p className="text-ui">已做好 8 页的季度回顾，并导出了 PowerPoint 文件。</p>
            <ChatArtifactCards
              artifacts={artifacts}
              answerMarkdown={props.answer ?? "已做好。"}
              threadId={THREAD}
            />
          </div>
        </WorkspaceFileOpenerContext.Provider>
      </SharedViewerContext.Provider>
    </MossLocaleScope>
  );
}

describe("chat deck and file cards", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useRightDockStore.getState().clearThreadDockState(ThreadId.makeUnsafe(THREAD));
  });

  it("opens the deck beside the chat and the file in the side panel, and saves the file", async () => {
    const opened: string[] = [];
    const opener: WorkspaceFileOpener = {
      openFile: (path) => {
        opened.push(path);
        return true;
      },
    };
    const fetchSpy = vi
      .spyOn(window, "fetch")
      .mockResolvedValue(new Response(new Blob(["PK"]), { status: 200 }));
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await page.viewport(900, 600);
    const screen = await render(<Cards opener={opener} />);
    try {
      const deckCard = page.getByRole("button", {
        name: "在侧边栏打开 2026 第三季度回顾",
        exact: true,
      });
      await expect.element(deckCard).toHaveTextContent("幻灯片 · 8 页 · 2026 第三季度回顾");
      await expect.element(page.getByText("PPTX · 1.2 MB", { exact: true })).toBeInTheDocument();
      await expect.element(page.getByText("ZIP", { exact: true })).toBeInTheDocument();
      await page.screenshot({
        path: "__screenshots__/chat-artifact-cards-zh.png",
        element: screen.container,
      });

      await deckCard.click();
      const dock = useRightDockStore.getState().dockStateByThreadId[THREAD];
      expect(dock?.open).toBe(true);
      expect(dock?.panes.map((pane) => [pane.kind, pane.deck])).toEqual([
        ["deck", { pageId: "page-1", scopeSpaceId: null, title: "2026 第三季度回顾" }],
      ]);

      await page
        .getByRole("button", { name: "在侧边栏打开 2026 第三季度回顾.pptx", exact: true })
        .click();
      await page.getByRole("button", { name: "在侧边栏打开 素材.zip", exact: true }).click();
      expect(opened).toEqual(["C:/work/out/2026 第三季度回顾.pptx", "素材.zip"]);

      await page
        .getByRole("button", { name: "将 2026 第三季度回顾.pptx 另存为", exact: true })
        .click();
      await vi.waitFor(() => expect(clickSpy).toHaveBeenCalledOnce());
      const url = new URL(String(fetchSpy.mock.calls[0]![0]));
      expect(url.pathname).toBe("/api/thread-output");
      expect(url.searchParams.get("threadId")).toBe(THREAD);
      expect(url.searchParams.get("file")).toBe("out/2026 第三季度回顾.pptx");
      expect(url.searchParams.get("sha256")).toBe("c".repeat(64));
    } finally {
      await screen.unmount();
    }
  });

  it("leaves out a file the answer already shows, and offers no actions to a shared viewer", async () => {
    const screen = await render(
      <Cards
        shared
        answer="[素材.zip](/api/thread-output?threadId=thread-cards&file=%E7%B4%A0%E6%9D%90.zip)"
      />,
    );
    try {
      await expect.element(page.getByText("2026 第三季度回顾.pptx")).toBeInTheDocument();
      expect(screen.container.querySelector('[data-chat-file-card="素材.zip"]')).toBeNull();
      expect(screen.container.querySelector("button")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});
