import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeAgentGatewayWrapUpTool } from "./wrapUpTool.ts";

const tool = makeAgentGatewayWrapUpTool();
const call = (input: Record<string, unknown>) =>
  Effect.runPromise(tool.handler(input, {} as Parameters<typeof tool.handler>[1]));

describe("moss_wrap_up", () => {
  it("is a read-only tool any thread may call", () => {
    expect(tool.definition.name).toBe("moss_wrap_up");
    expect(tool.requiredCapability).toBe("thread:read");
    expect(tool.definition.annotations?.readOnlyHint).toBe(true);
    expect(tool.definition.inputSchema.required).toEqual(["recap"]);
  });

  it("confirms the box and says whether it holds a question", async () => {
    const payload = (result: Awaited<ReturnType<typeof call>>) => {
      const first = result.content[0];
      return JSON.parse(first?.type === "text" ? first.text : "{}") as { hasQuestion: boolean };
    };
    expect(payload(await call({ recap: "Tests pass; nothing committed." })).hasQuestion).toBe(
      false,
    );
    const asking = await call({
      recap: "Fix is ready.",
      ask: "Commit it?",
      actions: [{ label: "Commit" }],
    });
    expect(payload(asking).hasQuestion).toBe(true);
  });

  it("refuses a box without a recap", async () => {
    const result = await call({ ask: "Go?" });
    expect(result.isError).toBe(true);
  });
});
