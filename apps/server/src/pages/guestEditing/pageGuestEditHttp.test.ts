import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import {
  GUEST_ROUTES,
  PAGE_GUEST_EDIT_ORIGIN_HEADER,
  PAGE_GUEST_EDIT_LIMITS as limits,
  type PageGuestEditTicket,
} from "@moss/contracts";
import type { ProjectionObservation } from "./guestProjectionSessions";
import { PageGuestEditHttp, decodeGuestEditBytes } from "./pageGuestEditHttp";
import { PageGuestEditStreams } from "./pageGuestEditStreams";
import { handlePageGuestRequest, type PageGuestOperations } from "../sharing/pageGuestHandler";
import type { PageProjectionOperations } from "./GuestPageProjectionService";

const ticket: PageGuestEditTicket = { sessionKey: "a".repeat(64), epoch: "b".repeat(32) };
const origin = "https://owner.example";
const input = { v: 1, pageId: "fixture-page", entry: { visitor: "fixture-visitor" } };
const text = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const source = () => ({ parentOrigin: origin, shareId: "fixture-publisher" });
const unsupported = async (): Promise<never> => {
  throw new Error("private test canary");
};
const operations: PageProjectionOperations = {
  open: unsupported,
  read: unsupported,
  submit: unsupported,
  observe: unsupported,
  release: unsupported,
};
async function call(
  edit: PageGuestEditHttp,
  route: string,
  value: unknown,
  overrides: Record<string, string> = {},
) {
  const bytes = text(value);
  const response = await Effect.runPromise(
    handlePageGuestRequest({ edit } as PageGuestOperations, {
      method: "POST",
      route,
      query: "",
      signal: new AbortController().signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        [PAGE_GUEST_EDIT_ORIGIN_HEADER]: origin,
        ...overrides,
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    }),
  );
  return {
    status: response.status,
    body: response.body ? await new Response(response.body).json() : null,
  };
}
afterEach(() => vi.useRealTimers());
describe("guest edit HTTP and stream lifecycle", () => {
  it.each(["", "A", "AA=", "A+", "A/", "AB", "AAA=", "A".repeat(limits.encodedChars + 1)])(
    "rejects malformed or oversized bytes %#",
    (encoded) => {
      expect(() => decodeGuestEditBytes(encoded)).toThrow("invalid");
    },
  );
  it("accepts exact canonical binary at its ceiling", () => {
    const value = Buffer.alloc(limits.bytes, 253);
    expect(decodeGuestEditBytes(value.toString("base64url"))).toEqual(value);
  });
  it("returns only the public seed and hides unexpected operation errors", async () => {
    const owner = new PageGuestEditHttp(
      { ...operations, open: async () => ({ ticket, revision: 1, seed: Uint8Array.of(255) }) },
      source,
    );
    expect(await call(owner, GUEST_ROUTES.pageEditOpen, input)).toEqual({
      status: 200,
      body: { v: 1, ticket, revision: 1, seed: "_w", expiresInMs: 60000 },
    });
    expect(
      await call(owner, GUEST_ROUTES.pageEditUpdate, { ...input, ticket, update: "AQ" }),
    ).toEqual({ status: 404, body: { reason: "unavailable" } });
    expect(
      await call(owner, GUEST_ROUTES.pageEditOpen, input, {
        [PAGE_GUEST_EDIT_ORIGIN_HEADER]: "null",
      }),
    ).toEqual({ status: 403, body: { reason: "forbidden" } });
  });
  it.each([
    { ...input, ownerState: "private" },
    { ...input, entry: { ...input.entry, actor: "owner" } },
    { ...input, entry: { visitor: "a" } },
    { ...input, pageId: "a".repeat(4097) },
  ])("rejects extra or oversized input before projection %#", async (body) => {
    const open = vi.fn(unsupported);
    const owner = new PageGuestEditHttp({ ...operations, open }, source);
    expect(await call(owner, GUEST_ROUTES.pageEditOpen, body)).toEqual({
      status: 400,
      body: { reason: "invalid" },
    });
    expect(open).not.toHaveBeenCalled();
  });
  it("expires at the original deadline even while a recheck is pending, removing its subscription", async () => {
    vi.useFakeTimers();
    const streams = new PageGuestEditStreams();
    const off = vi.fn();
    const check = vi.fn(
      (signal: AbortSignal) =>
        new Promise<"ended">((resolve) =>
          signal.addEventListener("abort", () => resolve("ended"), { once: true }),
        ),
    );
    const observation: ProjectionObservation = {
      revision: 1,
      expires: Date.now() + 100,
      listen: () => off,
      check,
    };
    const stream = await streams.open(
      ticket,
      new AbortController().signal,
      () => true,
      async () => observation,
    );
    await expect(
      streams.open(
        ticket,
        new AbortController().signal,
        () => true,
        async () => observation,
      ),
    ).rejects.toThrow("rate-limited");
    const reader = stream.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"type":"ready"');
    await vi.advanceTimersByTimeAsync(101);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"type":"ended"');
    expect(await reader.read()).toMatchObject({ done: true });
    expect(off).toHaveBeenCalledOnce();
    streams.close();
  });
  it("cancels a subscriber and admits the same ticket again", async () => {
    const streams = new PageGuestEditStreams();
    const off = vi.fn();
    const admit = async (): Promise<ProjectionObservation> => ({
      revision: 1,
      expires: Date.now() + 60000,
      listen: () => off,
      check: async () => "ready",
    });
    const first = await streams.open(ticket, new AbortController().signal, () => true, admit);
    await first.cancel();
    expect(off).toHaveBeenCalledOnce();
    const second = await streams.open(ticket, new AbortController().signal, () => true, admit);
    streams.close();
    expect(off).toHaveBeenCalledTimes(2);
    await second.cancel();
  });
});
