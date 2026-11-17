import { expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({ executeInMainWorld: vi.fn() }));
vi.mock("electron", () => ({ contextBridge: electron }));

import { installWebMcpBridgeInMainWorld } from "./guestBridge";

// The bridge used to keep only readOnlyHint and untrustedContentHint, so a page's
// consequentialHint never reached Moss. Only a tool marked read-only, and not also
// consequential, may run without the person being asked.
it("keeps consequentialHint and treats a tool without hints as consequential", async () => {
  const fakeDocument = Object.assign(new EventTarget(), {
    documentElement: new EventTarget(),
    permissionsPolicy: { features: () => ["tools"], allowsFeature: () => true },
    querySelectorAll: () => [],
  });
  vi.stubGlobal("document", fakeDocument);
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("location", { origin: "https://app.example" });
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe(): void {}
    },
  );

  installWebMcpBridgeInMainWorld();

  const modelContext = (
    fakeDocument as typeof fakeDocument & {
      readonly modelContext: {
        readonly registerTool: (tool: Record<string, unknown>) => Promise<void>;
        readonly getTools: () => Promise<ReadonlyArray<Record<string, unknown>>>;
      };
    }
  ).modelContext;
  const register = (name: string, annotations?: Record<string, boolean>) =>
    modelContext.registerTool({
      name,
      description: `Tool ${name}.`,
      ...(annotations ? { annotations } : {}),
      execute: async () => null,
    });
  await register("a_snapshot", { readOnlyHint: true, untrustedContentHint: true });
  await register("b_act", { readOnlyHint: false, consequentialHint: true });
  await register("c_no_hints");
  await register("d_read_but_consequential", { readOnlyHint: true, consequentialHint: true });
  await register("e_writes_says_harmless", { consequentialHint: false });

  const page = await modelContext.getTools();
  expect(page.map((tool) => [tool.name, tool.annotations])).toEqual([
    ["a_snapshot", { readOnlyHint: true, untrustedContentHint: true }],
    ["b_act", { readOnlyHint: false, consequentialHint: true, untrustedContentHint: false }],
    ["c_no_hints", { readOnlyHint: false, untrustedContentHint: false }],
    [
      "d_read_but_consequential",
      { readOnlyHint: true, consequentialHint: true, untrustedContentHint: false },
    ],
    [
      "e_writes_says_harmless",
      { readOnlyHint: false, consequentialHint: false, untrustedContentHint: false },
    ],
  ]);

  const bridge = (
    globalThis as typeof globalThis & {
      readonly __mossWebMcpBridgeV1: {
        list: () => Promise<{ tools: ReadonlyArray<Record<string, unknown>> }>;
      };
    }
  ).__mossWebMcpBridgeV1;
  const listed = await bridge.list();
  expect(listed.tools.map((tool) => [tool.name, tool.annotations])).toEqual([
    ["a_snapshot", { readOnlyHint: true, consequentialHint: false, untrustedContentHint: true }],
    ["b_act", { readOnlyHint: false, consequentialHint: true, untrustedContentHint: true }],
    ["c_no_hints", { readOnlyHint: false, consequentialHint: true, untrustedContentHint: true }],
    [
      "d_read_but_consequential",
      { readOnlyHint: true, consequentialHint: true, untrustedContentHint: true },
    ],
    // A page cannot talk its way out of approval without saying read-only.
    [
      "e_writes_says_harmless",
      { readOnlyHint: false, consequentialHint: true, untrustedContentHint: true },
    ],
  ]);
});
