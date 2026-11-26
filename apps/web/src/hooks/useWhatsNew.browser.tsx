import "../index.css";

import { DEFAULT_SERVER_SETTINGS_VIEW } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { AnnouncementSheet } from "../components/AnnouncementSheet";
import { useAnnouncementSheetSlotStore } from "../components/announcementSheetSlot";
import { MossWhatsNewDialogHost } from "../components/MossWhatsNewDialog";
import WhatsNewDialog from "../components/WhatsNewDialog";
import { WhatsNewHeaderButton } from "../components/WhatsNewHeaderButton";
import { serverQueryKeys } from "../lib/serverReactQuery";
import { MossLocalizationProvider } from "../localization";
import { useOnboardingDialogStore } from "../onboarding/onboardingDialogStore";
import { APP_SETTINGS_STORAGE_KEY } from "../uiLocale";
import {
  MOSS_WHATS_NEW_HEADER_STORAGE_KEY,
  resetMossWhatsNewHeaderStore,
} from "../whatsNew/useMossWhatsNew";
import { WhatsNewPopoutCard } from "../whatsNew/WhatsNewPopoutCard";
import { useWhatsNew } from "../whatsNew/useWhatsNew";

// 产品键保留 Moss 前缀（apps/web/src/whatsNew/useWhatsNew.ts 的 WHATS_NEW_STORAGE_KEY）。
const storageKey = "moss:whats-new:v1";
const entry = {
  version: "1.0.0",
  date: "Oct 5",
  features: [{ id: "welcome", title: "Welcome", description: "Release highlights" }],
};

beforeEach(() => {
  localStorage.setItem(storageKey, JSON.stringify({ lastSeenVersion: "0.9.9" }));
  localStorage.removeItem(MOSS_WHATS_NEW_HEADER_STORAGE_KEY);
  resetMossWhatsNewHeaderStore();
  useAnnouncementSheetSlotStore.setState({ owner: null, handedOff: false });
  useOnboardingDialogStore.setState({
    startupGateSettled: true,
    isOpen: false,
    betaWelcomePending: false,
  });
});
afterEach(() => {
  localStorage.removeItem(storageKey);
  localStorage.removeItem(MOSS_WHATS_NEW_HEADER_STORAGE_KEY);
  localStorage.removeItem(APP_SETTINGS_STORAGE_KEY);
  resetMossWhatsNewHeaderStore();
});

function WhatsNew() {
  const notes = useWhatsNew({ entries: [entry], currentVersion: "1.0.0" });
  return (
    <>
      {notes.isPopoutVisible && (
        <WhatsNewPopoutCard
          entry={entry}
          currentVersion={notes.currentVersion}
          onOpen={notes.openDialog}
          onDismiss={notes.dismissPopout}
        />
      )}
      <WhatsNewDialog
        open={notes.isDialogOpen}
        onOpenChange={notes.onDialogOpenChange}
        currentEntry={notes.currentEntry}
        allEntries={notes.allEntries}
        currentVersion={notes.currentVersion}
      />
    </>
  );
}

it("keeps update notes unseen while queued and retains the slot from card through dialog", async () => {
  useAnnouncementSheetSlotStore.getState().claim("onboarding");
  const screen = await render(
    <>
      <WhatsNew />
      <AnnouncementSheet
        open
        hero={null}
        title="Waiting announcement"
        description="Body"
        confirmLabel="Continue"
        onDismiss={() => {}}
        onConfirm={() => {}}
      />
    </>,
  );
  try {
    await expect
      .element(page.getByRole("button", { name: "Open What's new in v1.0.0" }))
      .not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({ lastSeenVersion: "0.9.9" });
    useAnnouncementSheetSlotStore.getState().release("onboarding");
    await page.getByRole("button", { name: "Open What's new in v1.0.0" }).click();
    await expect
      .element(page.getByRole("button", { name: "Open What's new in v1.0.0" }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("dialog", { name: "Waiting announcement" }))
      .not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({ lastSeenVersion: "0.9.9" });
    await page.getByRole("button", { name: "Got it" }).click();
    await expect.element(page.getByRole("dialog", { name: "Waiting announcement" })).toBeVisible();
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({ lastSeenVersion: "1.0.0" });
  } finally {
    await screen.unmount();
  }
});

it("shows the quiet top-right What's new button after an update, opens release notes, and hides on close", async () => {
  localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride: "zh-CN" }));
  localStorage.setItem(
    MOSS_WHATS_NEW_HEADER_STORAGE_KEY,
    JSON.stringify({ lastSeenVersion: "1.0.17" }),
  );
  resetMossWhatsNewHeaderStore();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);

  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <MossLocalizationProvider>
        <div className="flex h-[44px] w-full items-center justify-end gap-2 bg-[var(--app-rail-shell-background)] px-4">
          <WhatsNewHeaderButton currentVersion="1.0.18" />
        </div>
        <MossWhatsNewDialogHost currentVersion="1.0.18" />
      </MossLocalizationProvider>
    </QueryClientProvider>,
  );

  try {
    // Never auto-opens a modal on boot.
    await expect.element(page.getByTestId("moss-whats-new-dialog")).not.toBeInTheDocument();
    const button = page.getByTestId("whats-new-header-button");
    await expect.element(button).toBeVisible();
    await expect.element(button).toHaveTextContent("新功能");

    // Clicking opens the changelog dialog and persists the seen version.
    await button.click();
    const dialog = page.getByTestId("moss-whats-new-dialog");
    await expect.element(dialog).toBeVisible();
    await expect.element(dialog).toHaveTextContent("1.0.18");
    await expect.element(dialog).toHaveTextContent("11月27日");
    await expect.element(dialog).toHaveTextContent("新增");
    await expect.element(dialog).toHaveTextContent("改进");
    await expect.element(dialog).toHaveTextContent("修复");
    await expect.element(dialog).toHaveTextContent("1.0.17");
    expect(JSON.parse(localStorage.getItem(MOSS_WHATS_NEW_HEADER_STORAGE_KEY)!)).toEqual({
      lastSeenVersion: "1.0.18",
    });

    // Closing the dialog hides the top-right trigger until a newer version arrives.
    await page.getByRole("button", { name: "关闭" }).click();
    await expect.element(dialog).not.toBeInTheDocument();
    await expect.element(button).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
    queryClient.clear();
  }
});
