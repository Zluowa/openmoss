/**
 * Whether this thread's browser is the server's headless one, streamed.
 *
 * True only when the connected server says its agents use its own browser
 * (`WS_SERVER_HOSTED_BROWSER_CAPABILITY`, advertised by `BrowserAutomationHostLive`):
 * the web client, a phone, or the desktop app's SSH and paired remote-workspace
 * window. Never in the desktop app's own window, whose server drives the
 * native webview; and never before a server has said so, so the native panel
 * keeps its place wherever no server browser is in play.
 */
import { WS_SERVER_HOSTED_BROWSER_CAPABILITY } from "@moss/contracts";
import { useSyncExternalStore } from "react";

import { isElectron } from "~/env";
import { onWsServerCapabilitiesChange, readWsServerCapabilities } from "~/wsNativeApi";

const subscribe = (onChange: () => void) =>
  isElectron ? () => undefined : onWsServerCapabilitiesChange(onChange, { attachOnly: true });

const read = () =>
  !isElectron && readWsServerCapabilities()?.includes(WS_SERVER_HOSTED_BROWSER_CAPABILITY) === true;

export function useServerHostedBrowser(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
