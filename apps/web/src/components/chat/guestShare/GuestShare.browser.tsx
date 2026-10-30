// FILE: GuestShare.browser.tsx
// Purpose: Exercise the owner's "share with guest" dialog, header control, and waiting-message
//          card in a real Chromium renderer against a mocked guestShare API.
// Layer: Browser UI test

import "../../../index.css";

import {
  type GuestMessageId,
  type GuestShareId,
  type ThreadGuestMessage,
  type ThreadGuestShare,
  ThreadId,
  WsRpcError,
} from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  create: vi.fn(),
  close: vi.fn(),
  resolveMessage: vi.fn(),
  onEvent: vi.fn(() => () => undefined),
}));

vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/nativeApi")>()),
  ensureGuestShareApi: () => harness,
}));

import { useGuestShareDialogStore } from "~/guestShareDialogStore";
import { useGuestShareStore } from "~/guestShareStore";
import { resetThemeSnapshotCacheForTests } from "~/hooks/useTheme";
import { MossLocaleScope } from "~/localization";
import { DEFAULT_THEME_STATE, serializeThemeState } from "~/theme/theme.logic";
import { GuestPendingMessages } from "./GuestPendingMessages";
import { GuestShareDialog } from "./GuestShareDialog";
import { GuestShareHeaderButton } from "./GuestShareHeaderButton";

const THREAD_ID = ThreadId.makeUnsafe("thread-guest-share");
const SHARE_ID = "AAAAAAAAAAAAAAAAAAAAAA" as GuestShareId;
const INVITE_URL = `https://moss-share.example/s/${SHARE_ID}#invite-secret`;
const HOUR_MS = 60 * 60 * 1000;

function share(overrides: Partial<ThreadGuestShare> = {}): ThreadGuestShare {
  const now = Date.now();
  return {
    id: SHARE_ID,
    threadId: THREAD_ID,
    relayOrigin: "https://moss-share.example",
    inviteUrl: INVITE_URL,
    createdAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 23 * HOUR_MS + 15 * 60_000).toISOString(),
    guestName: null,
    guestJoinedAt: null,
    messages: [],
    relayStatus: "online",
    ...overrides,
  };
}

function joinedShare(messages: ThreadGuestMessage[]): ThreadGuestShare {
  return share({
    inviteUrl: null,
    guestName: "Ada",
    guestJoinedAt: new Date(Date.now() - 30_000).toISOString(),
    messages,
  });
}

function guestMessage(
  id: string,
  text: string,
  overrides: Partial<ThreadGuestMessage> = {},
): ThreadGuestMessage {
  return {
    id: id as GuestMessageId,
    text,
    status: "pending",
    submittedAt: new Date().toISOString(),
    attachments: [],
    ...overrides,
  };
}

function seed(...shares: ThreadGuestShare[]): void {
  useGuestShareStore.getState().applyEvent({ type: "snapshot", shares });
}

beforeEach(async () => {
  await page.viewport(1_100, 760);
  useGuestShareStore.getState().clear();
  useGuestShareDialogStore.getState().close();
  harness.create.mockReset();
  harness.close.mockReset();
  harness.resolveMessage.mockReset();
});

afterEach(() => {
  document.body.replaceChildren();
  localStorage.removeItem("moss:theme");
  resetThemeSnapshotCacheForTests();
  vi.restoreAllMocks();
});

describe("GuestShareDialog", () => {
  it("creates a one-time link, shows it with Copy, and can stop sharing", async () => {
    harness.create.mockImplementation(async () => ({ share: share(), inviteUrl: INVITE_URL }));
    harness.close.mockResolvedValue(undefined);
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const mounted = await render(
      <GuestShareDialog threadId={THREAD_ID} open onOpenChange={() => {}} onSignIn={() => {}} />,
    );
    try {
      await expect.element(page.getByRole("heading", { name: "Share with guest" })).toBeVisible();
      await expect
        .element(page.getByText("The link works once and expires in 24 hours."))
        .toBeVisible();

      await page.getByRole("button", { name: "Create link" }).click();
      await expect
        .element(page.getByRole("textbox", { name: "Guest link" }))
        .toHaveValue(INVITE_URL);
      expect(harness.create).toHaveBeenCalledWith({ threadId: THREAD_ID });
      await expect.element(page.getByText("Waiting for the guest to open the link")).toBeVisible();
      await expect.element(page.getByText("A new link ends the current one.")).toBeVisible();
      expect(useGuestShareStore.getState().sharesByThreadId[THREAD_ID]?.id).toBe(SHARE_ID);

      await page.getByRole("button", { name: "Copy" }).click();
      await expect.element(page.getByRole("button", { name: "Copied" })).toBeVisible();
      expect(writeText).toHaveBeenCalledWith(INVITE_URL);

      await page.getByRole("button", { name: "Stop sharing" }).click();
      await vi.waitFor(() => expect(harness.close).toHaveBeenCalledWith({ threadId: THREAD_ID }));
      await expect.element(page.getByRole("button", { name: "Create link" })).toBeVisible();
      expect(useGuestShareStore.getState().sharesByThreadId[THREAD_ID]).toBeUndefined();
    } finally {
      await mounted.unmount();
    }
  });

  it("localizes guest_share.account_required by code and offers sign-in", async () => {
    harness.create.mockRejectedValue(
      new WsRpcError({
        message: "Sign in with a Moss account to share threads with guests.",
        code: "guest_share.account_required",
      }),
    );
    const onSignIn = vi.fn();
    const mounted = await render(
      <MossLocaleScope locale="zh-CN">
        <GuestShareDialog threadId={THREAD_ID} open onOpenChange={() => {}} onSignIn={onSignIn} />
      </MossLocaleScope>,
    );
    try {
      await expect.element(page.getByRole("heading", { name: "分享给访客" })).toBeVisible();
      await page.getByRole("button", { name: "生成链接" }).click();
      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("登录 Moss 账号后才能将对话分享给访客。");
      await page.getByRole("button", { name: "登录" }).click();
      expect(onSignIn).toHaveBeenCalledOnce();
    } finally {
      await mounted.unmount();
    }
  });
});

describe("GuestPendingMessages", () => {
  it("shows each waiting message with Dismiss and Send and resolves it with that decision", async () => {
    harness.resolveMessage.mockResolvedValue(undefined);
    const first = guestMessage("m1", "Can you add tests for the parser?");
    const second = guestMessage("m2", "Also update the docs", {
      attachments: [
        {
          type: "file",
          id: "att-notes" as never,
          name: "notes.md",
          mimeType: "text/markdown",
          sizeBytes: 2_048,
        },
      ],
    });
    seed(joinedShare([first, second]));
    const mounted = await render(
      <div style={{ width: 720 }}>
        <GuestPendingMessages threadId={THREAD_ID} onImageExpand={() => {}} />
      </div>,
    );
    try {
      const card = page.getByRole("region", { name: "2 messages from Ada are waiting" });
      await expect.element(card).toBeVisible();
      await expect.element(page.getByText("Can you add tests for the parser?")).toBeVisible();
      await expect.element(page.getByText("notes.md")).toBeVisible();

      await page.getByRole("button", { name: "Send message from Ada" }).first().click();
      await vi.waitFor(() =>
        expect(harness.resolveMessage).toHaveBeenCalledWith({
          threadId: THREAD_ID,
          guestMessageId: "m1",
          decision: "send",
        }),
      );
      useGuestShareStore.getState().applyEvent({
        type: "upsert",
        share: joinedShare([{ ...first, status: "sent" }, second]),
      });
      await expect
        .element(page.getByRole("region", { name: "1 message from Ada is waiting" }))
        .toBeVisible();

      await page.getByRole("button", { name: "Dismiss message from Ada" }).click();
      await vi.waitFor(() =>
        expect(harness.resolveMessage).toHaveBeenLastCalledWith({
          threadId: THREAD_ID,
          guestMessageId: "m2",
          decision: "dismiss",
        }),
      );
      useGuestShareStore.getState().applyEvent({
        type: "upsert",
        share: joinedShare([
          { ...first, status: "sent" },
          { ...second, status: "dismissed" },
        ]),
      });
      // The card collapses through the shared disclosure motion and leaves the
      // accessibility tree (aria-hidden + inert) once nothing is waiting.
      await expect
        .element(page.getByRole("region", { name: /waiting|等待处理/ }))
        .not.toBeInTheDocument();
      expect(harness.resolveMessage).toHaveBeenCalledTimes(2);
    } finally {
      await mounted.unmount();
    }
  });
});

describe("GuestShareHeaderButton", () => {
  it("reads Share idle, Sharing with the guest's name and count once live, and opens the dialog", async () => {
    const mounted = await render(
      <div className="flex items-center gap-3 p-3">
        <GuestShareHeaderButton threadId={THREAD_ID} compact={false} />
        <GuestShareHeaderButton threadId={THREAD_ID} compact />
      </div>,
    );
    try {
      await expect
        .element(page.getByRole("button", { name: "Share with guest" }).first())
        .toHaveTextContent("Share");

      seed(joinedShare([guestMessage("m1", "Ping")]));
      const live = page.getByRole("button", { name: "Ada is watching · 1 waiting" });
      await expect.element(live.first()).toHaveTextContent("Sharing1");
      // The compact variant keeps only the glyph and the status dot.
      await expect.element(live.nth(1)).not.toHaveTextContent("Sharing");
      expect(live.nth(1).element().querySelector("[data-guest-share-tone='live']")).not.toBeNull();

      await live.first().click();
      expect(useGuestShareDialogStore.getState().threadId).toBe(THREAD_ID);
    } finally {
      await mounted.unmount();
    }
  });
});

// Opt-in captures for design review (VITE_GUEST_SHARE_SCREENSHOTS=1). Vite only lets the
// page write inside the workspace, so they land in the web app's node_modules cache.
const SCREENSHOTS_ENABLED =
  (import.meta.env.VITE_GUEST_SHARE_SCREENSHOTS as string | undefined)?.trim() === "1";
const SCREENSHOT_DIR = "../../../../node_modules/.cache/guest-share-screenshots";

describe.skipIf(!SCREENSHOTS_ENABLED)("screenshots", () => {
  for (const locale of ["en", "zh-CN"] as const) {
    for (const theme of ["light", "dark"] as const) {
      it(`captures ${locale} ${theme}`, async () => {
        // useTheme applies the stored mode on mount, so the mode has to come from storage.
        localStorage.setItem(
          "moss:theme",
          serializeThemeState({ ...DEFAULT_THEME_STATE, mode: theme }),
        );
        resetThemeSnapshotCacheForTests();
        seed(
          joinedShare([
            guestMessage("m1", "Could you also cover the empty-input case in the parser tests?"),
            guestMessage("m2", "Here are the notes from the review.", {
              attachments: [
                {
                  type: "file",
                  id: "att-notes" as never,
                  name: "review-notes.md",
                  mimeType: "text/markdown",
                  sizeBytes: 4_096,
                },
              ],
            }),
          ]),
        );
        const surface = await render(
          <MossLocaleScope locale={locale}>
            <div className="min-h-screen bg-background p-8 text-foreground">
              <div className="mb-6 flex items-center justify-end gap-2">
                <GuestShareHeaderButton threadId={THREAD_ID} compact={false} />
                <GuestShareHeaderButton threadId={THREAD_ID} compact />
              </div>
              <div className="mx-auto w-[720px]">
                <GuestPendingMessages threadId={THREAD_ID} onImageExpand={() => {}} />
              </div>
            </div>
          </MossLocaleScope>,
        );
        await expect.element(page.getByRole("region").first()).toBeVisible();
        await new Promise((resolve) => setTimeout(resolve, 400));
        await page.screenshot({ path: `${SCREENSHOT_DIR}/pending-${locale}-${theme}.png` });
        await surface.unmount();

        seed(share());
        const dialog = await render(
          <MossLocaleScope locale={locale}>
            <div className="min-h-screen bg-background">
              <GuestShareDialog
                threadId={THREAD_ID}
                open
                onOpenChange={() => {}}
                onSignIn={() => {}}
              />
            </div>
          </MossLocaleScope>,
        );
        await expect.element(page.getByRole("dialog")).toBeVisible();
        await new Promise((resolve) => setTimeout(resolve, 400));
        await page.screenshot({ path: `${SCREENSHOT_DIR}/dialog-${locale}-${theme}.png` });
        await dialog.unmount();
      });
    }
  }
});
