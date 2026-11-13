import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { PageTypesDashboardQueryResult } from "./pageTypes";

describe("PageTypesDashboardQueryResult", () => {
  // The RPC sends results as JSON; a Schema.Unknown answer was encoded as null.
  it.each([
    ["file text", "month,revenue\n2026-10,421\n"],
    ["structured rows", [{ month: "2026-10", revenue: 421 }]],
    ["a single value", { value: 109.4 }],
  ])("keeps the answer through the JSON codec: %s", (_, answer) => {
    const codec = Schema.toCodecJson(PageTypesDashboardQueryResult);
    const value = { status: "ok" as const, answer, at: "2026-11-13T00:00:00.000Z" };
    const wire = JSON.parse(JSON.stringify(Schema.encodeUnknownSync(codec)(value)));
    expect(wire.answer).toEqual(answer);
    expect(Schema.decodeUnknownSync(codec)(wire)).toEqual(value);
  });
});
