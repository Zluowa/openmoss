import { Effect, Ref } from "effect";
import { describe, expect, it } from "vitest";

import type { McpToolCallResult } from "./protocol.ts";
import { gateToolsByMossApp } from "./mossAppGate.ts";
import type { ToolContext, ToolEntry } from "./toolRuntime.ts";

function tool(name: string, available?: boolean): ToolEntry {
  return {
    definition: { name, description: name, inputSchema: { type: "object" } },
    requiredCapability: "thread:read",
    handler: () =>
      Effect.succeed<McpToolCallResult>({ content: [{ type: "text", text: `ran ${name}` }] }),
    ...(available === undefined ? {} : { available: () => Effect.succeed(available) }),
  };
}

const context = {} as ToolContext;
const firstText = (result: { readonly content: ReadonlyArray<unknown> }) =>
  (result.content[0] as { readonly text: string }).text;

describe("gateToolsByMossApp", () => {
  it("hides and refuses a turned-off app's tools, and only those", async () => {
    const disabled = Ref.makeUnsafe<ReadonlyArray<string>>(["moss.media"]);
    const [media, pages, threads] = gateToolsByMossApp(
      [tool("moss_media_generate"), tool("moss_pages_read"), tool("moss_list_threads")],
      Ref.get(disabled),
    );

    expect(await Effect.runPromise(media!.available!())).toBe(false);
    expect(await Effect.runPromise(pages!.available!())).toBe(true);
    // Core tools are passed through untouched.
    expect(threads!.available).toBeUndefined();

    const refused = await Effect.runPromise(media!.handler({}, context));
    expect(firstText(refused)).toContain("app_disabled");
    expect(firstText(refused)).toContain("moss.media");
    expect(firstText(await Effect.runPromise(pages!.handler({}, context)))).toBe(
      "ran moss_pages_read",
    );

    // Flipping the switch applies on the next listing and call.
    await Effect.runPromise(Ref.set(disabled, []));
    expect(await Effect.runPromise(media!.available!())).toBe(true);
    expect(firstText(await Effect.runPromise(media!.handler({}, context)))).toBe(
      "ran moss_media_generate",
    );
  });

  it("keeps a tool's own availability", async () => {
    const [unavailable] = gateToolsByMossApp([tool("moss_pages_read", false)], Effect.succeed([]));
    expect(await Effect.runPromise(unavailable!.available!())).toBe(false);
  });

  it("treats an unreadable setting as on", async () => {
    const [media] = gateToolsByMossApp([tool("moss_media_get")], Effect.fail("broken"));
    expect(await Effect.runPromise(media!.available!())).toBe(true);
  });
});
