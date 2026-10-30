import "../index.css";

import { DEFAULT_SERVER_SETTINGS_VIEW } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { serverQueryKeys } from "../lib/serverReactQuery";
import { MossLocalizationProvider } from "../localization";
import { APP_SETTINGS_STORAGE_KEY } from "../uiLocale";
import type { WhatsNewEntry } from "./logic";
import { WhatsNewPopoutCard } from "./WhatsNewPopoutCard";

const ENTRY: WhatsNewEntry = {
  version: "0.7.6",
  date: "2026-09-01",
  features: [
    {
      id: "in-app-update",
      title: "Update Moss from inside the app",
      description: "Signed releases download in the background and install with one click.",
    },
  ],
};

async function renderCard(input: {
  sidebarWidth?: number;
  onOpen?: () => void;
  onDismiss?: () => void;
}) {
  localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride: "en" }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <MossLocalizationProvider>
        {input.sidebarWidth !== undefined ? (
          <div data-slot="sidebar" data-side="left">
            <div data-slot="sidebar-gap" style={{ width: input.sidebarWidth, height: 1 }} />
          </div>
        ) : null}
        <WhatsNewPopoutCard
          entry={ENTRY}
          currentVersion="0.7.6"
          onOpen={input.onOpen ?? (() => {})}
          onDismiss={input.onDismiss ?? (() => {})}
        />
      </MossLocalizationProvider>
    </QueryClientProvider>,
  );
  return {
    cleanup: async () => {
      await screen.unmount();
      queryClient.clear();
      document.body.innerHTML = "";
    },
  };
}

function card(): HTMLElement {
  return document.querySelector<HTMLElement>("[aria-label^='Open'], [role='button']")!
    .parentElement!;
}

describe("WhatsNewPopoutCard", () => {
  it("renders the release card at the fallback width without a fitted sidebar", async () => {
    const mounted = await renderCard({});
    try {
      const shell = card();
      expect(shell).not.toBeNull();
      expect(shell.getBoundingClientRect().width).toBe(256);
      expect(shell.textContent).toContain("0.7.6");
      expect(shell.textContent).toContain("Update Moss from inside the app");
    } finally {
      await mounted.cleanup();
    }
  });

  it("fits inside the live sidebar width, clamped to the readable range", async () => {
    for (const [sidebarWidth, expected] of [
      [240, 216],
      [400, 288],
      [180, 256],
    ] as const) {
      const mounted = await renderCard({ sidebarWidth });
      try {
        await vi.waitFor(() => {
          expect(card().getBoundingClientRect().width).toBe(expected);
        });
      } finally {
        await mounted.cleanup();
      }
    }
  });

  it("opens from the body and dismisses from the close button without opening", async () => {
    const onOpen = vi.fn();
    const onDismiss = vi.fn();
    const mounted = await renderCard({ onOpen, onDismiss });
    try {
      await page.getByRole("button", { name: /0\.7\.6/ }).click();
      expect(onOpen).toHaveBeenCalledTimes(1);
      await page.getByRole("button", { name: /dismiss/i }).click();
      expect(onDismiss).toHaveBeenCalledTimes(1);
      expect(onOpen).toHaveBeenCalledTimes(1);
    } finally {
      await mounted.cleanup();
    }
  });
});
