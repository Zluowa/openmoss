import {
  GUEST_ROUTES,
  PAGE_APP_PREVIEW_LIMITS,
  PageGuestAppPreviewBrokerResult,
  PageGuestAppPreviewOpenResult,
  guestApiPath,
  type PageAppPreviewRelayCapability,
  type PageGuestAppPreviewBrokerRequest,
  type PageGuestAppPreviewOpenRequest,
} from "@moss/contracts";
import { Schema } from "effect";
import type { PageGuestResult } from "./pageGuestTransport";

export interface GuestAppPreviewTransport {
  readonly config: (signal: AbortSignal) => Promise<PageAppPreviewRelayCapability | null>;
  readonly inspect?: (
    proof: PageGuestAppPreviewBrokerRequest,
    signal: AbortSignal,
  ) => Promise<PageGuestResult<PageGuestAppPreviewBrokerResult>>;
  readonly open: (
    request: PageGuestAppPreviewOpenRequest,
    signal: AbortSignal,
  ) => Promise<PageGuestResult<PageGuestAppPreviewOpenResult>>;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (
    response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
      "application/json" ||
    !response.body
  ) {
    await response.body?.cancel();
    throw new Error("Invalid preview response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > PAGE_APP_PREVIEW_LIMITS.openBodyBytes)
        throw new Error("Preview response exceeds limit");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createGuestAppPreviewTransport(
  shareId: string,
  fetchImpl: typeof fetch,
): GuestAppPreviewTransport {
  return {
    async config(signal) {
      try {
        const response = await fetchImpl("/v1/app-previews/config", {
          signal,
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          headers: { accept: "application/json" },
        });
        if (!response.ok) {
          await response.body?.cancel();
          return null;
        }
        const value = (await boundedJson(response)) as Record<string, unknown> | null;
        return value?.available === true &&
          value.protocolVersion === 1 &&
          typeof value.contentOrigin === "string" &&
          value.contentOrigin.length <= 2_048
          ? {
              protocolVersion: 1,
              contentOrigin: value.contentOrigin,
              ...(value.brokerProtocol === 1 ? { brokerProtocol: 1 as const } : {}),
            }
          : null;
      } catch {
        return null;
      }
    },
    async inspect(proof, signal) {
      try {
        const response = await fetchImpl(guestApiPath(shareId, GUEST_ROUTES.pageAppPreviewBroker), {
          method: "POST",
          signal,
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(proof),
        });
        const value = await boundedJson(response);
        if (response.ok)
          return {
            ok: true,
            value: Schema.decodeUnknownSync(PageGuestAppPreviewBrokerResult)(value),
          };
        return { ok: false, failure: { kind: "refused", reason: "unavailable" } };
      } catch {
        return { ok: false, failure: { kind: "network" } };
      }
    },
    async open(request, signal) {
      try {
        const response = await fetchImpl(guestApiPath(shareId, GUEST_ROUTES.pageAppPreviewOpen), {
          method: "POST",
          signal,
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(request),
        });
        const value = await boundedJson(response);
        if (response.ok)
          return {
            ok: true,
            value: Schema.decodeUnknownSync(PageGuestAppPreviewOpenResult)(value),
          };
        return { ok: false, failure: { kind: "refused", reason: "unavailable" } };
      } catch {
        return { ok: false, failure: { kind: "network" } };
      }
    },
  };
}
