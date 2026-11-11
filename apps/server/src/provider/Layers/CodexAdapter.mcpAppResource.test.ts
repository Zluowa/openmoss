// FILE: CodexAdapter.mcpAppResource.test.ts
// Purpose: Adapter-shape guard for the Codex MCP App resource read. An upstream merge on
// 2026-10-02 dropped `CodexAdapter.readMcpAppResource`; the manager method survived, so every
// other test stayed green while widgets failed with 409. This checks the live adapter exposes
// the binding and forwards to the manager.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  ThreadId,
  type McpAppResourceReadInput,
  type McpAppResourceReadResult,
} from "@moss/contracts";
import { Effect, Layer, Option } from "effect";
import { expect } from "vitest";

import { CodexAppServerManager } from "../../codexAppServerManager.ts";
import { ServerConfig } from "../../config.ts";
import { CodexAdapter } from "../Services/CodexAdapter.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { makeCodexAdapterLive } from "./CodexAdapter.ts";

class ResourceReadManager extends CodexAppServerManager {
  readonly reads: McpAppResourceReadInput[] = [];

  override async readMcpAppResource(
    input: McpAppResourceReadInput,
  ): Promise<McpAppResourceReadResult> {
    this.reads.push(input);
    return { state: "no_content", resourceUri: input.resourceUri };
  }

  override hasSession(): boolean {
    return false;
  }

  override async stopAll(): Promise<void> {}
}

const manager = new ResourceReadManager();
const layer = it.layer(
  makeCodexAdapterLive({ manager }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(
      Layer.succeed(ProviderSessionDirectory, {
        upsert: () => Effect.void,
        getProvider: () => Effect.die(new Error("unused")),
        getBinding: () => Effect.succeed(Option.none()),
        remove: () => Effect.void,
        listThreadIds: () => Effect.succeed([]),
        listBindings: () => Effect.succeed([]),
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("CodexAdapter MCP App resource binding", (it) => {
  it.effect("exposes readMcpAppResource and forwards it to the manager", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      expect(typeof adapter.readMcpAppResource).toBe("function");
      const input: McpAppResourceReadInput = {
        threadId: ThreadId.makeUnsafe("thread-shape"),
        callId: "call-shape",
        server: "fixture",
        resourceUri: "ui://fixture/widget.html",
        source: "resultMeta",
      };
      const result = yield* adapter.readMcpAppResource!(input);
      expect(result).toEqual({ state: "no_content", resourceUri: input.resourceUri });
      expect(manager.reads).toEqual([input]);
    }),
  );
});
