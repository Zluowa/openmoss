import "../index.css";

import { ProjectId, ThreadId } from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { QuickChatItem } from "./QuickChat.logic";
import { SidebarQuickChat } from "./SidebarQuickChat";
import { SidebarMenu, SidebarProvider } from "./ui/sidebar";

vi.mock("./ChatView", () => ({
  default: ({ threadId }: { threadId: string }) => (
    <div data-testid="quick-chat-mounted-chat-view">{threadId}</div>
  ),
}));

const THREAD_ID = ThreadId.makeUnsafe("quick-chat-browser-thread");
const THREAD: QuickChatItem = {
  id: THREAD_ID,
  projectId: ProjectId.makeUnsafe("quick-chat-browser-project"),
  title: "Browser test conversation",
  updatedAt: "2026-07-10T12:00:00.000Z",
  isPinned: false,
  unread: false,
  streaming: false,
};

function QuickChatHarness({ expanded }: { readonly expanded: boolean }) {
  return (
    <SidebarProvider open={expanded}>
      <SidebarMenu>
        <SidebarQuickChat
          threads={[THREAD]}
          initialThreadId={THREAD_ID}
          shortcutLabel="⌥⌘N"
          onCreateDetached={() => THREAD_ID}
          onAttachToTask={() => undefined}
          onMarkVisited={() => undefined}
        />
      </SidebarMenu>
    </SidebarProvider>
  );
}

function quickChatTrigger(): HTMLButtonElement {
  const trigger = document.querySelector<HTMLButtonElement>(
    '[data-testid="sidebar-quick-chat"] button',
  );
  if (!trigger) throw new Error("Quick Chat trigger was not rendered");
  return trigger;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = "";
  window.localStorage.clear();
});

describe("SidebarQuickChat", () => {
  it.each([true, false])(
    "shows the first-use coachmark while the sidebar expanded state is %s",
    async (expanded) => {
      const screen = await render(<QuickChatHarness expanded={expanded} />);
      try {
        await page.getByTestId("sidebar-quick-chat").hover({ force: true });
        await vi.waitFor(() => {
          expect(document.querySelector('[data-testid="quick-chat-first-use-coachmark"]')).not.toBe(
            null,
          );
        });
        expect(document.querySelector('[data-testid="quick-chat-recent-card"]')).toBeNull();
      } finally {
        await screen.unmount();
      }
    },
  );

  it.each([true, false])(
    "shows recent chats after first open while the sidebar expanded state is %s",
    async (expanded) => {
      window.localStorage.setItem("has-opened-quick-chat-v1", "true");
      const screen = await render(<QuickChatHarness expanded={expanded} />);
      try {
        await page.getByTestId("sidebar-quick-chat").hover({ force: true });
        await vi.waitFor(() => {
          expect(document.querySelector('[data-testid="quick-chat-recent-card"]')).not.toBe(null);
        });
        expect(document.querySelector('[data-testid="quick-chat-first-use-coachmark"]')).toBeNull();
      } finally {
        await screen.unmount();
      }
    },
  );

  it.each([
    [true, "ArrowDown"],
    [true, "ArrowRight"],
    [false, "ArrowDown"],
    [false, "ArrowRight"],
  ] as const)(
    "opens recent chats with %s/%s and restores trigger focus on Escape",
    async (expanded, arrowKey) => {
      window.localStorage.setItem("has-opened-quick-chat-v1", "true");
      const screen = await render(<QuickChatHarness expanded={expanded} />);
      try {
        const trigger = quickChatTrigger();
        trigger.focus();
        trigger.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: arrowKey,
          }),
        );

        await vi.waitFor(() => {
          expect(document.activeElement).toBe(
            document.querySelector<HTMLButtonElement>('[data-quick-chat-recent-focusable="true"]'),
          );
        });

        const recentItem = document.querySelector<HTMLButtonElement>(
          '[data-quick-chat-recent-focusable="true"]',
        );
        if (!recentItem) throw new Error("Recent Quick Chat item did not receive focus");
        recentItem.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }),
        );
        await vi.waitFor(() => {
          expect(document.querySelector('[data-testid="quick-chat-recent-card"]')).toBeNull();
          expect(document.activeElement).toBe(trigger);
        });
      } finally {
        await screen.unmount();
      }
    },
  );

  it("keeps active chat and history pages mounted while making the inactive page inert", async () => {
    window.localStorage.setItem("has-opened-quick-chat-v1", "true");
    const screen = await render(<QuickChatHarness expanded />);
    try {
      quickChatTrigger().click();
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="quick-chat-window"]')).not.toBeNull();
      });

      const chatView = document.querySelector('[data-testid="quick-chat-mounted-chat-view"]');
      const historyPage = document.querySelector<HTMLElement>('[data-testid="quick-chat-history"]');
      const activePage = document.querySelector<HTMLElement>('[data-testid="quick-chat-active"]');
      expect(chatView).not.toBeNull();
      expect(historyPage?.hidden).toBe(true);
      expect(historyPage?.getAttribute("aria-hidden")).toBe("true");
      expect(historyPage?.hasAttribute("inert")).toBe(true);
      expect(activePage?.hidden).toBe(false);
      expect(activePage?.getAttribute("aria-hidden")).toBe("false");
      expect(activePage?.hasAttribute("inert")).toBe(false);

      document.getElementById("sidebar-quick-chat-window-title")?.click();
      await vi.waitFor(() => {
        expect(historyPage?.hidden).toBe(false);
        expect(activePage?.hidden).toBe(true);
      });
      expect(historyPage?.getAttribute("aria-hidden")).toBe("false");
      expect(historyPage?.hasAttribute("inert")).toBe(false);
      expect(activePage?.getAttribute("aria-hidden")).toBe("true");
      expect(activePage?.hasAttribute("inert")).toBe(true);
      expect(document.querySelector('[data-testid="quick-chat-mounted-chat-view"]')).toBe(chatView);
    } finally {
      await screen.unmount();
    }
  });
});
