// FILE: placePhotoTools.test.ts
// Purpose: Contract for the `place_photos` gateway tool: only credited, reusable
//          Wikimedia Commons photos come back, and every failure is a text-card stop.

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  commonsCredit,
  commonsFileName,
  fetchPlacePhotos,
  makeAgentGatewayPlacePhotoTool,
  PLACE_PHOTOS_DEADLINE_MS,
  PLACE_PHOTOS_NETWORK_MESSAGE,
  plainCreditText,
  summaryPhotoFile,
} from "./placePhotoTools.ts";
import type { ToolContext } from "./toolRuntime.ts";
import { PublicJsonHttpError, type RequestPublicJson } from "../publicJson.ts";

const THUMB =
  "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Half_Moon_Bay.jpg/330px-Half_Moon_Bay.jpg";
const ORIGINAL = "https://upload.wikimedia.org/wikipedia/commons/a/ab/Half_Moon_Bay.jpg";

const summary = { thumbnail: { source: THUMB }, originalimage: { source: ORIGINAL } };
const ARTIST = '<a href="//commons.wikimedia.org/wiki/User:A">Ann &amp; Bo</a>';
const metadata = (license: string, artist = ARTIST) => ({
  query: {
    pages: {
      "1": {
        imageinfo: [
          { extmetadata: { Artist: { value: artist }, LicenseShortName: { value: license } } },
        ],
      },
    },
  },
});

function fakeRequester(routes: Record<string, unknown>) {
  const seen: string[] = [];
  const origins: string[][] = [];
  const impl: RequestPublicJson = async (policy, request) => {
    seen.push(request.url);
    origins.push([...policy.allowedOrigins]);
    const key = Object.keys(routes).find((prefix) => request.url.startsWith(prefix));
    if (key === undefined) throw new PublicJsonHttpError("place_photos", 404);
    return routes[key];
  };
  return { impl, seen, origins };
}

// A blocked network: every request hangs until the call's deadline ends it.
const hanging: RequestPublicJson = () => new Promise(() => undefined);

function makeContext(): ToolContext {
  return {
    principal: {
      kind: "provider-session",
      sessionKey: "session-caller",
      threadId: "thread-caller",
      provider: "codex",
      turnId: "turn-caller",
    },
    callerThreadId: "thread-caller",
    callerThreadLabel: null,
    callerSessionKey: "session-caller",
    callerProvider: "codex",
    callerCapabilities: new Set(["thread:read"]),
    callerTurnId: "turn-caller",
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
  };
}

describe("place photo parsing", () => {
  it("names the Commons file behind original and thumbnail URLs", () => {
    expect(commonsFileName(ORIGINAL)).toBe("Half_Moon_Bay.jpg");
    expect(commonsFileName(THUMB)).toBe("Half_Moon_Bay.jpg");
    expect(
      commonsFileName("http://upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg"),
    ).toBeUndefined();
    expect(commonsFileName("https://example.com/wikipedia/commons/a/ab/X.jpg")).toBeUndefined();
    expect(commonsFileName("https://upload.wikimedia.org/wikipedia/en/a/ab/X.jpg")).toBeUndefined();
  });

  it("needs the thumbnail and the original to show the same file", () => {
    expect(summaryPhotoFile(summary)).toEqual({ imageUrl: THUMB, file: "Half_Moon_Bay.jpg" });
    expect(
      summaryPhotoFile({
        thumbnail: { source: THUMB },
        originalimage: { source: "https://upload.wikimedia.org/wikipedia/commons/c/cd/Other.jpg" },
      }),
    ).toBeUndefined();
    expect(summaryPhotoFile({})).toBeUndefined();
  });

  it("keeps only reusable licenses with a named creator, as plain text", () => {
    expect(commonsCredit(metadata("CC BY-SA 4.0"))).toEqual({
      artist: "Ann & Bo",
      license: "CC BY-SA 4.0",
    });
    expect(commonsCredit(metadata("Public domain"))?.license).toBe("Public domain");
    expect(commonsCredit(metadata("Fair use"))).toBeUndefined();
    expect(commonsCredit(metadata("CC BY 4.0", ""))).toBeUndefined();
    expect(plainCreditText("<b>A&#39;s</b>&nbsp;photo &#x263A;")).toBe("A's photo ☺");
  });

  it("decodes entities before stripping tags, so encoded markup never comes back as tags", () => {
    expect(plainCreditText("&lt;script&gt;alert(1)&lt;/script&gt;Ann")).toBe("alert(1)Ann");
    expect(plainCreditText('&lt;a href="x"&gt;Bo&lt;/a&gt; &amp;lt;i&amp;gt;')).toBe(
      "Bo &lt;i&gt;",
    );
    // An out-of-range code point is dropped instead of throwing.
    expect(plainCreditText("Ann&#99999999;")).toBe("Ann");
  });
});

describe("fetchPlacePhotos", () => {
  it("returns a credited photo and a text-card stop for a failure", async () => {
    const { impl, seen } = fakeRequester({
      "https://en.wikipedia.org/api/rest_v1/page/summary/Half_Moon_Bay%2C_California": summary,
      "https://commons.wikimedia.org/w/api.php": metadata("CC BY-SA 4.0"),
    });
    const result = await fetchPlacePhotos(
      ["Half Moon Bay, California", "Nowhere at all"],
      "en",
      impl,
    );
    expect(result.places[0]).toEqual({
      status: "available",
      place: "Half Moon Bay, California",
      image_url: THUMB,
      artist: "Ann & Bo",
      license: "CC BY-SA 4.0",
      credit_url: "https://commons.wikimedia.org/wiki/File:Half_Moon_Bay.jpg",
      article_url: "https://en.wikipedia.org/wiki/Half_Moon_Bay%2C_California",
    });
    expect(result.places[1]).toMatchObject({ status: "unavailable", place: "Nowhere at all" });
    expect(seen.some((url) => url.includes("titles=File%3AHalf_Moon_Bay.jpg"))).toBe(true);
  });

  it("asks the article's own edition and allows only it and Commons", async () => {
    const { impl, seen, origins } = fakeRequester({});
    await fetchPlacePhotos(["西湖"], "zh", impl);
    expect(seen[0]?.startsWith("https://zh.wikipedia.org/api/rest_v1/page/summary/")).toBe(true);
    expect(origins[0]).toEqual(["https://zh.wikipedia.org", "https://commons.wikimedia.org"]);
  });

  it("says once that photos are unavailable on this network, within the deadline", async () => {
    const started = Date.now();
    const result = await fetchPlacePhotos(["The Bund", "Yu Garden"], "en", hanging, {
      deadlineMs: 50,
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.network).toEqual({ available: false, message: PLACE_PHOTOS_NETWORK_MESSAGE });
    expect(result.network?.message).toMatch(/unavailable on this network/u);
    expect(result.places).toEqual([
      expect.objectContaining({ status: "unavailable", place: "The Bund" }),
      expect.objectContaining({ status: "unavailable", place: "Yu Garden" }),
    ]);
    // The real deadline keeps the whole call to about four seconds.
    expect(PLACE_PHOTOS_DEADLINE_MS).toBeLessThanOrEqual(4_000);
  });

  it("gives every request only the time left before the deadline", async () => {
    const timeouts: number[] = [];
    const refused: RequestPublicJson = async (policy) => {
      timeouts.push(policy.timeoutMs);
      throw new Error("connect ECONNREFUSED");
    };
    const result = await fetchPlacePhotos(["Lisbon"], "en", refused);
    expect(timeouts[0]).toBeLessThanOrEqual(PLACE_PHOTOS_DEADLINE_MS);
    expect(result.network?.available).toBe(false);
  });

  it("keeps a reachable network that simply has no photo off the network message", async () => {
    const result = await fetchPlacePhotos(["Nowhere at all"], "en", fakeRequester({}).impl);
    expect(result.network).toBeUndefined();
    expect(result.places[0]).toMatchObject({ status: "unavailable" });
    expect((result.places[0] as { reason: string }).reason).not.toMatch(/network/u);
  });

  it("reads an uppercase or multi-part edition code", async () => {
    const { impl, seen } = fakeRequester({});
    const tool = makeAgentGatewayPlacePhotoTool({ request: impl });
    await Effect.runPromise(
      tool.handler({ titles: ["Taipei"], language: "ZH-min-nan" }, makeContext()),
    );
    expect(seen[0]?.startsWith("https://zh-min-nan.wikipedia.org/")).toBe(true);
  });
});

describe("place_photos agent tool", () => {
  it("is a read-only lookup that rejects bad input as a tool error", async () => {
    const tool = makeAgentGatewayPlacePhotoTool({ request: fakeRequester({}).impl });
    expect(tool.definition.name).toBe("place_photos");
    expect(tool.requiredCapability).toBe("thread:read");
    expect(tool.definition.annotations?.readOnlyHint).toBe(true);
    const tooMany = await Effect.runPromise(
      tool.handler({ titles: Array.from({ length: 9 }, (_, i) => `Place ${i}`) }, makeContext()),
    );
    expect(tooMany.isError).toBe(true);
    const badLanguage = await Effect.runPromise(
      tool.handler({ titles: ["Lisbon"], language: "../evil" }, makeContext()),
    );
    expect(badLanguage.isError).toBe(true);
  });

  it("is withheld from a mainland China phone session and refuses a call by name", async () => {
    const { impl, seen } = fakeRequester({});
    const tool = makeAgentGatewayPlacePhotoTool({
      request: impl,
      available: () => Effect.succeed(false),
    });
    expect(await Effect.runPromise(tool.available!())).toBe(false);
    const result = await Effect.runPromise(tool.handler({ titles: ["Lisbon"] }, makeContext()));
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("mainland China");
    expect(seen).toEqual([]);
  });

  it("answers with every place, available or not", async () => {
    const tool = makeAgentGatewayPlacePhotoTool({ request: fakeRequester({}).impl });
    const result = await Effect.runPromise(tool.handler({ titles: ["Lisbon"] }, makeContext()));
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      source: "Wikipedia / Wikimedia Commons",
      places: [{ status: "unavailable", place: "Lisbon" }],
    });
  });
});
