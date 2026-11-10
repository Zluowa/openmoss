import type { PageAppPreviewRelayCapability } from "@moss/contracts";
import { isPageAppHttpOrigin } from "@moss/shared/pageAppContentPolicy";

/** Three independent gates: current owner registration, relay config, prepared parent CSP. */
export function guestAppPreviewOrigin(
  owner: PageAppPreviewRelayCapability | undefined,
  relay: PageAppPreviewRelayCapability | null,
  preparedOrigins: readonly string[],
  parentOrigin: string,
): string | null {
  if (
    !owner ||
    owner.protocolVersion !== 1 ||
    !relay ||
    relay.protocolVersion !== 1 ||
    owner.contentOrigin !== relay.contentOrigin ||
    preparedOrigins.length !== 1 ||
    preparedOrigins[0] !== relay.contentOrigin ||
    !isPageAppHttpOrigin(parentOrigin) ||
    !isPageAppHttpOrigin(relay.contentOrigin)
  )
    return null;
  const parent = new URL(parentOrigin),
    content = new URL(relay.contentOrigin);
  const loopback = (hostname: string) => ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  if (
    parent.hostname === content.hostname ||
    parent.protocol !== content.protocol ||
    (parent.protocol !== "https:" && !(loopback(parent.hostname) && loopback(content.hostname)))
  )
    return null;
  return relay.contentOrigin;
}
