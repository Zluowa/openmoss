// FILE: SandboxedHtmlDocument.tsx
// Purpose: Shared, least-privilege iframe primitive for all agent-authored inline HTML.
// Layer: Chat UI
// Origin: The frame-message handling follows HtmlRenderDocument in
//   apps/web/src/components/files/BrowserDocumentFrame.tsx in T3 Code
//   (https://github.com/pingdotgg/t3code, MIT) at 08a463e29976617134de01e9341f898bc881d0eb.
//   Moss opens links with its chat link actions and images in its own viewer, and puts
//   a page's follow-up in the thread's composer (the reader sends it, as with OpenUI).
//   See THIRD_PARTY_NOTICES.md.

import {
  htmlRenderError,
  htmlRenderResult,
  htmlRenderShortcutsMessage,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  readHtmlRenderContentHeight,
  readHtmlRenderFollowUpRequest,
  readHtmlRenderImageRequest,
  readHtmlRenderKeyDown,
  readHtmlRenderLinkRequest,
  readHtmlRenderMapConfigRequest,
  htmlRenderResultValue,
} from "@moss/shared/htmlRender";
import { useContext, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";

import { useHtmlRenderShortcutPolicy } from "~/hooks/useHtmlRenderShortcutPolicy";
import { useHtmlRenderTheme } from "~/hooks/useHtmlRenderTheme";
import { htmlRenderMapConfigForPage, readHtmlRenderMapConfig } from "~/lib/htmlRenderMapConfig";
import { isHtmlRenderShortcut } from "~/lib/htmlRenderShortcuts";
import { useTranslation } from "~/localization";
import { openExternalLink } from "~/lib/linkChips";
import { ChatLinkActionsContext, resolveChatLinkClickOpener } from "~/lib/linkContextMenu";
import { cn } from "~/lib/utils";
import { VisualFollowUpContext } from "~/lib/visualFollowUp";

import { ExpandedImageOverlay } from "./ExpandedImageOverlay";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { useExpandedImagePreview } from "./useExpandedImagePreview";

const FOLLOW_UP_INTERVAL_MS = 1000;

/**
 * Agent content has an opaque sandboxed origin. Both T3's html_render pages
 * and Codex fragment visualizations use this exact frame so sandbox policy,
 * theme delivery and height signaling cannot drift.
 */
export function SandboxedHtmlDocument(props: {
  readonly src: string;
  readonly title: string;
  readonly className?: string;
  /** T3's inline HTML pages omit popups; generic panel documents opt in. */
  readonly sandbox?: "allow-scripts allow-forms" | "allow-scripts allow-forms allow-popups";
  readonly onContentHeight?: (height: number) => void;
  readonly onLoad?: () => void;
  /**
   * Shows a page image the reader clicked. A frame in a virtualized list hands it to
   * the list's viewer, which outlives the row; without it the frame shows its own.
   */
  readonly onImageExpand?: (preview: ExpandedImagePreview) => void;
  /**
   * An html_render visual reply: it may go fullscreen, and a map page on it gets the
   * map configuration (provider and key) for the reader's account. Other agent frames
   * get neither.
   */
  readonly htmlRender?: boolean;
  /** The live frame, for a client that talks to the page itself (page comments). */
  readonly onFrame?: (frame: HTMLIFrameElement | null) => void;
}) {
  const theme = useHtmlRenderTheme();
  const shortcutPolicy = useHtmlRenderShortcutPolicy();
  const linkActions = useContext(ChatLinkActionsContext);
  const sendFollowUp = useContext(VisualFollowUpContext);
  const { t } = useTranslation();
  const { expandedImage, setExpandedImage, closeExpandedImage, navigateExpandedImage } =
    useExpandedImagePreview();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const lastFollowUpAtRef = useRef(Number.NEGATIVE_INFINITY);
  const [src] = useState(() => `${props.src.split("#", 1)[0]}${htmlRenderThemeFragment(theme)}`);
  const [loaded, setLoaded] = useState(false);
  const postTheme = () =>
    frameRef.current?.contentWindow?.postMessage(htmlRenderThemeMessage(theme), "*");
  useEffect(postTheme, [theme]);
  const postShortcuts = () =>
    frameRef.current?.contentWindow?.postMessage(
      htmlRenderShortcutsMessage(shortcutPolicy.shortcuts, shortcutPolicy.blocked),
      "*",
    );
  useEffect(postShortcuts, [shortcutPolicy]);
  // Like a chat link: a pull request or issue follows the reader's setting, and
  // Cmd/Ctrl-click or any other URL opens in the external browser.
  const openLink = useEffectEvent(
    (url: string, modifiers: { metaKey: boolean; ctrlKey: boolean }) => {
      const openGitHubItem =
        modifiers.metaKey || modifiers.ctrlKey
          ? undefined
          : resolveChatLinkClickOpener(url, linkActions);
      if (openGitHubItem) openGitHubItem(url);
      else openExternalLink(url);
    },
  );
  // Links, keys and images require frame focus and recent reader activity: a page can
  // take focus by script, so this blocks opens on load, though not a page that waits
  // for the reader's next input.
  const onFrameMessage = useEffectEvent((frame: HTMLIFrameElement, event: MessageEvent) => {
    const height = readHtmlRenderContentHeight(event.data);
    if (height !== undefined) {
      props.onContentHeight?.(height);
      return;
    }
    // A map page asks on load which map to draw. Only a visual reply gets the answer, and
    // the key goes to this live frame only: the stored page never holds it.
    const mapConfigRequest = readHtmlRenderMapConfigRequest(event.data);
    if (mapConfigRequest !== undefined) {
      if (props.htmlRender !== true) {
        frame.contentWindow?.postMessage(
          htmlRenderResultValue(mapConfigRequest.id, { provider: "plain" }),
          "*",
        );
        return;
      }
      void readHtmlRenderMapConfig().then((config) =>
        frame.contentWindow?.postMessage(
          htmlRenderResultValue(
            mapConfigRequest.id,
            htmlRenderMapConfigForPage(config, t("chat.htmlRender.mapPlainNote")),
          ),
          "*",
        ),
      );
      return;
    }
    if (document.activeElement !== frame || navigator.userActivation?.isActive === false) return;
    const linkRequest = readHtmlRenderLinkRequest(event.data);
    if (linkRequest !== undefined) {
      openLink(linkRequest.url, linkRequest);
      frame.contentWindow?.postMessage(htmlRenderResult(linkRequest.id), "*");
      return;
    }
    // Lands in the composer for the reader to send, so a page never spends a turn itself.
    // One click's activation lasts seconds, so a page gets one follow-up per click: the
    // frame gives up focus and repeats within a second are refused.
    const followUp = readHtmlRenderFollowUpRequest(event.data);
    if (followUp !== undefined) {
      const now = performance.now();
      if (sendFollowUp === null || now - lastFollowUpAtRef.current < FOLLOW_UP_INTERVAL_MS) {
        frame.contentWindow?.postMessage(
          htmlRenderError(
            followUp.id,
            sendFollowUp === null
              ? "Follow-ups are available only inside a thread."
              : "Wait for the reader's next click before sending another follow-up.",
          ),
          "*",
        );
        return;
      }
      lastFollowUpAtRef.current = now;
      frame.blur();
      sendFollowUp(followUp.text);
      frame.contentWindow?.postMessage(htmlRenderResult(followUp.id), "*");
      return;
    }
    const key = readHtmlRenderKeyDown(event.data);
    if (key !== undefined) {
      // The app's shortcut listeners see the press as if the frame had not taken it.
      if (isHtmlRenderShortcut(key, shortcutPolicy, navigator.platform)) {
        frame.dispatchEvent(
          new KeyboardEvent("keydown", { ...key, bubbles: true, cancelable: true }),
        );
      }
      return;
    }
    const imageRequest = readHtmlRenderImageRequest(event.data);
    if (imageRequest !== undefined) {
      // The viewer closes on Escape in the app's window, which a focused frame would keep.
      frame.blur();
      const preview = { images: [{ src: imageRequest.src, name: imageRequest.name }], index: 0 };
      if (props.onImageExpand) props.onImageExpand(preview);
      else setExpandedImage(preview);
    }
  });
  // Attached at commit, because a fast page can post its first height before
  // passive effects run.
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (frame === null) return;
    const onMessage = (event: MessageEvent) => {
      if (event.source === frame.contentWindow) onFrameMessage(frame, event);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  const reportFrame = useEffectEvent((frame: HTMLIFrameElement | null) => props.onFrame?.(frame));
  useLayoutEffect(() => {
    reportFrame(frameRef.current);
    return () => reportFrame(null);
  }, []);
  return (
    <>
      <iframe
        ref={frameRef}
        src={src}
        title={props.title}
        // Opaque origin; never permit same-origin or top-navigation privileges.
        sandbox={props.sandbox ?? "allow-scripts allow-forms"}
        // Only a visual reply's page may take the screen (for its video, map, or image
        // viewer); every other agent frame keeps the browser's default of no fullscreen.
        allow={props.htmlRender === true ? "fullscreen" : undefined}
        loading="lazy"
        onLoad={() => {
          setLoaded(true);
          // Covers a theme or keybinding change that landed while the page was loading.
          postTheme();
          postShortcuts();
          props.onLoad?.();
        }}
        className={cn("border-0 scheme-light", props.className)}
        style={loaded ? { colorScheme: theme.appearance } : undefined}
      />
      {props.onImageExpand ? null : (
        <ExpandedImageOverlay
          expandedImage={expandedImage}
          onClose={closeExpandedImage}
          onNavigate={navigateExpandedImage}
        />
      )}
    </>
  );
}
