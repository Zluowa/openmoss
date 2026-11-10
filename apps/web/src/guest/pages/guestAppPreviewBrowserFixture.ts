import type { GuestAppPreviewBrowser } from "./guestAppPreviewBrowserContract";

type PreviewWindow = Window & {
  previewMessages: Array<{ origin: string; data: { kind?: string } }>;
};

// Playwright serializes each callback into the guest browser; keep every body self-contained.
export const guestAppPreviewBrowser = {
  observeMessages: () => {
    const observed = window as unknown as PreviewWindow;
    observed.previewMessages = [];
    window.addEventListener("message", (event) => {
      observed.previewMessages.push({ origin: event.origin, data: event.data });
    });
  },
  sendInvalidBrokerMessages: () => {
    const frame = document.querySelector("iframe")!;
    const nonce = frame.name.replace("moss-app-preview-", "");
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "null",
        source: window,
        data: { protocol: "moss-readonly-app-item-v1", nonce, kind: "permissions-state", id: 94 },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: location.origin,
        source: frame.contentWindow,
        data: { protocol: "moss-readonly-app-item-v1", nonce, kind: "permissions-state", id: 95 },
      }),
    );
  },
  retainedData: () => {
    return JSON.stringify({
      html: document.documentElement.outerHTML,
      storage: { ...localStorage },
      messages: (window as unknown as PreviewWindow).previewMessages,
      urls: performance.getEntriesByType("resource").map((entry) => entry.name),
    });
  },
  messages: () => (window as unknown as PreviewWindow).previewMessages,
  navigateByLink: (origin) => {
    const anchor = document.createElement("a");
    anchor.href = `${origin}/unavailable`;
    document.body.append(anchor);
    anchor.click();
  },
  headerLuminance: () => {
    const color = getComputedStyle(
      document.querySelector("header")!.parentElement!,
    ).backgroundColor;
    const rgb =
      color
        .match(/[\d.]+/gu)
        ?.slice(0, 3)
        .map(Number) ?? [];
    return rgb.reduce((sum, value) => sum + value, 0) / 3;
  },
  fitsViewport: () => document.documentElement.scrollWidth <= innerWidth,
} satisfies GuestAppPreviewBrowser;
