import type {
  DesktopBridge,
  HtmlPreviewDescriptor,
  HtmlPreviewRegisterInput,
} from "@synara/contracts";

export type HtmlPreviewState = { phase: "loading" | "ready" } | { phase: "error"; message: string };

type HtmlPreviewBridge = NonNullable<DesktopBridge["htmlPreview"]>;
export const HTML_PREVIEW_LOAD_TIMEOUT_MS = 30_000;

function validDescriptor(value: HtmlPreviewDescriptor): boolean {
  if (!/^[a-f0-9]{48}$/u.test(value.id) || value.partition !== `moss-html-preview-${value.id}`)
    return false;
  try {
    const url = new URL(value.src);
    return (
      url.protocol === "moss-local-preview:" &&
      url.hostname === value.id &&
      !url.username &&
      !url.password &&
      !url.port
    );
  } catch {
    return false;
  }
}

/** The HTML never enters the application's DOM, srcdoc, or JavaScript context. */
export function mountHtmlPreview(
  container: HTMLElement,
  input: HtmlPreviewRegisterInput,
  bridge: HtmlPreviewBridge | undefined,
  onState: (state: HtmlPreviewState) => void,
): () => void {
  let disposed = false;
  let descriptor: HtmlPreviewDescriptor | undefined;
  let guest: HTMLElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners: Array<[string, EventListener]> = [];
  const release = () => {
    clearTimeout(timer);
    if (guest) {
      for (const [name, listener] of listeners) guest.removeEventListener(name, listener);
      guest.remove();
      guest = undefined;
    }
    const registration = descriptor;
    descriptor = undefined;
    if (registration) void bridge?.unregister({ id: registration.id }).catch(() => undefined);
  };
  const fail = (message: string) => {
    if (disposed) return;
    disposed = true;
    release();
    onState({ phase: "error", message });
  };
  const loading = () => {
    if (disposed) return;
    clearTimeout(timer);
    onState({ phase: "loading" });
    timer = setTimeout(
      () => fail("The HTML preview did not finish loading. Retry to start a new preview."),
      HTML_PREVIEW_LOAD_TIMEOUT_MS,
    );
  };
  if (!bridge) {
    fail(
      "Interactive HTML previews require the desktop app. You can still view this file's source here.",
    );
    return () => {
      disposed = true;
    };
  }
  loading();
  void bridge
    .register(input)
    .then((value) => {
      if (disposed) {
        void bridge.unregister({ id: value.id }).catch(() => undefined);
        return;
      }
      descriptor = value;
      if (!validDescriptor(value)) {
        fail("The desktop app returned an invalid HTML preview session.");
        return;
      }
      const element = container.ownerDocument.createElement("webview");
      guest = element;
      element.setAttribute("partition", value.partition);
      element.setAttribute("src", value.src);
      element.setAttribute("title", "HTML preview");
      element.setAttribute(
        "webpreferences",
        "contextIsolation=yes,sandbox=yes,nodeIntegration=no,webSecurity=yes",
      );
      element.className = "h-full min-h-[24rem] w-full flex-1";
      element.style.display = "flex";
      const listen = (name: string, listener: EventListener) => {
        listeners.push([name, listener]);
        element.addEventListener(name, listener);
      };
      listen("did-start-loading", loading);
      listen("did-finish-load", () => {
        if (disposed) return;
        clearTimeout(timer);
        onState({ phase: "ready" });
      });
      listen("did-fail-load", (event) => {
        const detail = event as Event & {
          isMainFrame?: boolean;
          errorCode?: number;
          errorDescription?: string;
        };
        if (detail.isMainFrame === false || detail.errorCode === -3) return;
        fail(
          `Unable to load this HTML preview${detail.errorDescription ? `: ${detail.errorDescription}` : "."}`,
        );
      });
      listen("render-process-gone", () =>
        fail("The HTML preview stopped unexpectedly. Retry to start a new preview."),
      );
      container.appendChild(element);
    })
    .catch((error: unknown) => {
      fail(error instanceof Error ? error.message : "Unable to start the HTML preview.");
    });
  return () => {
    disposed = true;
    release();
  };
}
