// FILE: BrowserPageTabs.tsx
// Purpose: The browser's page tabs as chips in the panel's own header row (site icon, page
//   title, close). A new tab reads "New tab" alone, as on the desktop: no globe, and no
//   close while it is the only tab. Owns only presentation and the tab actions; state comes
//   from the main process.
// Layer: BrowserPanel UI

import type { BrowserTabState, ThreadId } from "@moss/contracts";
import { useLayoutEffect, useRef, useState } from "react";
import { isBlankBrowserTabUrl } from "@moss/shared/browserSession";

import { GlobeIcon, LoaderCircleIcon } from "~/lib/icons";
import { scrollTabIntoView } from "~/lib/tabStrip";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { readNativeApi } from "~/nativeApi";

import { selectThreadBrowserState, useBrowserStateStore } from "../../browserStateStore";
import { SurfaceTabChip } from "../chat/chatHeaderControls";

/** Asks the thread's mounted browser panel to open a new tab and focus its address field. */
export const BROWSER_NEW_TAB_REQUEST_EVENT = "moss:browser-new-tab";

const EMPTY_TABS: readonly BrowserTabState[] = [];

export function requestBrowserNewTab(threadId: ThreadId): void {
  window.dispatchEvent(new CustomEvent(BROWSER_NEW_TAB_REQUEST_EVENT, { detail: { threadId } }));
}

function BrowserTabGlyph({ tab }: { tab: BrowserTabState }) {
  // A site without an icon (most dev servers) answers 404: fall back to the globe.
  const [failedIconUrl, setFailedIconUrl] = useState<string | null>(null);
  if (tab.isLoading) {
    return <LoaderCircleIcon aria-hidden className="size-4 animate-spin text-muted-foreground" />;
  }
  if (tab.faviconUrl && tab.faviconUrl !== failedIconUrl) {
    return (
      <img
        alt=""
        src={tab.faviconUrl}
        className="size-4 rounded-xs"
        draggable={false}
        onError={() => setFailedIconUrl(tab.faviconUrl)}
      />
    );
  }
  return <GlobeIcon aria-hidden className="size-4 text-[var(--color-text-foreground-secondary)]" />;
}

/**
 * One chip per page. `active` says whether the browser is the selected surface, so a
 * chip only reads as selected while the page is on screen.
 */
export function BrowserPageTabs(props: {
  readonly threadId: ThreadId;
  readonly active: boolean;
  /** Called after a chip is chosen, so the host can bring the browser to the front. */
  readonly onActivate?: (() => void) | undefined;
  /** The last page was closed. */
  readonly onLastTabClosed?: (() => void) | undefined;
}) {
  const { t, format } = useTranslation();
  const state = useBrowserStateStore(selectThreadBrowserState(props.threadId));
  const upsertThreadState = useBrowserStateStore((store) => store.upsertThreadState);
  const api = readNativeApi();
  const tabs = state?.tabs ?? EMPTY_TABS;
  const activeTabId = state?.activeTabId ?? tabs[0]?.id ?? null;
  // A page opened past the strip's visible edge must come into view, or opening it
  // looks like nothing happened.
  const sentinelRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const strip = sentinelRef.current?.parentElement;
    const activeChip = strip?.querySelector<HTMLElement>("[data-surface-tab-active]");
    if (strip && activeChip) scrollTabIntoView(strip, activeChip);
  }, [activeTabId, props.active, tabs.length]);
  if (tabs.length === 0) return null;

  return (
    <>
      <span ref={sentinelRef} hidden />
      {tabs.map((tab) => {
        const blank = isBlankBrowserTabUrl(tab);
        const title = tab.title.trim().length > 0 && !blank ? tab.title : t("browser.tabs.newTab");
        const onlyTab = tabs.length === 1;
        // A lone tab is plain text; with several, the one on screen is marked.
        const marked = props.active && tab.id === activeTabId && !onlyTab;
        return (
          <SurfaceTabChip
            key={tab.id}
            active={marked}
            title={title}
            // The end padding keeps the chip's edge fade over blank space unless the title
            // really runs long.
            label={
              <span className="pe-3" data-translation-skip="true">
                {title}
              </span>
            }
            // Tabs give way as more open, as in a browser, but keep a readable start of
            // their title; past that the strip scrolls.
            className={cn("shrink", marked ? "min-w-28" : onlyTab ? "min-w-0" : "min-w-20")}
            labelClassName="max-w-[11rem]"
            icon={blank && !tab.isLoading ? null : <BrowserTabGlyph tab={tab} />}
            closePlacement="trailing"
            closeLabel={format("browser.tabs.close", { title })}
            onSelect={() => {
              props.onActivate?.();
              if (!api || tab.id === activeTabId) return;
              void api.browser
                .selectTab({ threadId: props.threadId, tabId: tab.id })
                .then(upsertThreadState, () => undefined);
            }}
            onClose={
              onlyTab && blank
                ? undefined
                : () => {
                    if (!api) return;
                    void api.browser.closeTab({ threadId: props.threadId, tabId: tab.id }).then(
                      (next) => {
                        upsertThreadState(next);
                        if (next.tabs.length === 0) props.onLastTabClosed?.();
                      },
                      () => undefined,
                    );
                  }
            }
          />
        );
      })}
    </>
  );
}
