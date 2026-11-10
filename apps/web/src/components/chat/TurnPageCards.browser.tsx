// FILE: TurnPageCards.browser.tsx
// Purpose: The page card a turn's HTML file gets (title, status, opens the panel) and
//          the hover card on an inline file chip (kind, time, name).
// Layer: Focused component tests

import "../../index.css";

import type { NativeApi, ProjectReadFileResult } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { WorkspaceFileOpenerContext, type WorkspaceFileOpener } from "~/lib/workspaceFileOpener";

import { FileChipHoverCardContent } from "./FileChipHoverCard";
import { InlineMentionChip } from "./InlineMentionChip";
import { TurnPageCards } from "./TurnPageCards";

// Set VITE_ALIGNED_PREVIEW_SHOTS=1 to save review screenshots (git-ignored folder).
const SHOTS_DIR =
  import.meta.env.VITE_ALIGNED_PREVIEW_SHOTS === "1" ? "__screenshots__/aligned-preview" : null;

const htmlFile = (relativePath: string, contents: string): ProjectReadFileResult => ({
  relativePath,
  contents,
  truncated: false,
  version: `sha256:${"2".repeat(64)}`,
  encoding: "utf8",
  lineEnding: "lf",
});

async function withHarness(
  readFile: NativeApi["projects"]["readFile"],
  opener: WorkspaceFileOpener,
  children: ReactNode,
) {
  const previousApi = Object.getOwnPropertyDescriptor(window, "nativeApi");
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: { projects: { readFile } } as unknown as NativeApi,
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceFileOpenerContext.Provider value={opener}>
        <div className="w-[560px] p-6 text-chat">{children}</div>
      </WorkspaceFileOpenerContext.Provider>
    </QueryClientProvider>,
  );
  return {
    screen,
    cleanup: () => {
      queryClient.clear();
      if (previousApi) Object.defineProperty(window, "nativeApi", previousApi);
      else Reflect.deleteProperty(window, "nativeApi");
      document.body.innerHTML = "";
    },
  };
}

function makeOpener(): WorkspaceFileOpener & { openFile: ReturnType<typeof vi.fn> } {
  return { openFile: vi.fn(() => true) } as unknown as WorkspaceFileOpener & {
    openFile: ReturnType<typeof vi.fn>;
  };
}

it("shows a created page by its own title and opens it in the panel", async () => {
  await page.viewport(720, 420);
  const readFile = vi
    .fn()
    .mockResolvedValue(
      htmlFile("simple-page/index.html", "<html><head><title>盖碗冲泡计时</title></head></html>"),
    );
  const opener = makeOpener();
  const { cleanup } = await withHarness(
    readFile,
    opener,
    <TurnPageCards
      files={[
        { path: "simple-page/index.html", kind: "added", additions: 246, deletions: 0 },
        { path: "simple-page/app.ts", kind: "modified" },
        { path: "old.html", kind: "deleted" },
      ]}
      workspaceRoot="/workspace/ceshi"
      theme="light"
    />,
  );
  try {
    const card = page.getByRole("button", { name: "Open page 盖碗冲泡计时" });
    await expect.element(card).toBeVisible();
    // Only the live HTML page gets a card.
    expect(document.querySelectorAll("[data-turn-page-card]")).toHaveLength(1);
    await expect.element(page.getByText("Created", { exact: true })).toBeVisible();
    const box = document.querySelector("[data-turn-page-card]")!.getBoundingClientRect();
    expect(box.width).toBeLessThanOrEqual(318);
    expect(getComputedStyle(document.querySelector("[data-turn-page-card]")!).borderRadius).toBe(
      "8px",
    );
    if (SHOTS_DIR) await page.screenshot({ path: `${SHOTS_DIR}/after-page-card.png` });
    await card.click();
    expect(opener.openFile).toHaveBeenCalledWith("simple-page/index.html");
  } finally {
    cleanup();
  }
});

it("shows kind, name and the file's path on a hovered file chip", async () => {
  await page.viewport(720, 420);
  const opener = makeOpener();
  const { cleanup } = await withHarness(
    vi.fn(),
    opener,
    <p>
      写好了，打开{" "}
      <InlineMentionChip
        path="simple-page/index.html"
        theme="light"
        href="simple-page/index.html"
        onActivate={(event) => {
          event.preventDefault();
          opener.openFile("simple-page/index.html");
        }}
        hoverCard={<FileChipHoverCardContent path="simple-page/index.html" theme="light" />}
      />{" "}
      就能看到网页。
    </p>,
  );
  try {
    const chip = page.getByRole("link", { name: "index.html" });
    await chip.hover();
    await expect
      .element(page.getByText("HTML page", { exact: true }), { timeout: 4_000 })
      .toBeVisible();
    const card = document.querySelector<HTMLElement>("[data-file-chip-hover-card]")!;
    expect(card.textContent).toContain("index.html");
    // The native tooltip is replaced by the card.
    expect(document.querySelector("a[title]")).toBeNull();
    if (SHOTS_DIR) await page.screenshot({ path: `${SHOTS_DIR}/after-chip-hover-card.png` });
    await chip.click();
    expect(opener.openFile).toHaveBeenCalled();
  } finally {
    cleanup();
  }
});
