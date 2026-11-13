/**
 * How the guest share service reaches the relay: HTTP for registration and a WebSocket per
 * share. A service so tests can point it at an in-process relay and shape its backoff.
 */
import { Layer, ServiceMap } from "effect";
import WebSocket from "ws";

import type { ShareRelayHostBackoff } from "../shareRelayHostClient.ts";
import type { ShareRelayFetch } from "../shareRelayRegistration.ts";

export interface ShareRelayTransportShape {
  readonly fetch: ShareRelayFetch;
  readonly webSocket: typeof WebSocket;
  /** Where `MOSS_SHARE_RELAY_URL` and `MOSS_SHARE_RELAY_DEV_BEARER` are read from. */
  readonly env: NodeJS.ProcessEnv;
  readonly backoff?: ShareRelayHostBackoff;
}

export class ShareRelayTransport extends ServiceMap.Service<
  ShareRelayTransport,
  ShareRelayTransportShape
>()("moss/guestShare/Services/ShareRelayTransport") {}

export const ShareRelayTransportLive = Layer.succeed(ShareRelayTransport, {
  fetch: (input, init) => globalThis.fetch(input, init),
  webSocket: WebSocket,
  env: process.env,
});
