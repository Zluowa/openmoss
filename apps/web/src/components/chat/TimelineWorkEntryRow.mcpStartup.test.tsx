// FILE: TimelineWorkEntryRow.mcpStartup.test.tsx
// Purpose: A Codex MCP server that failed to start reads as one whole sentence, in Chinese
//   for zh-CN, without a heading made from the server name or Codex's command to run.
// Layer: Chat transcript UI regression test

import { TurnId } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const localeState = vi.hoisted(() => ({ locale: "zh-CN" as "en" | "zh-CN" }));

vi.mock("~/appSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/appSettings")>();
  return {
    ...actual,
    useAppSettings: () => ({
      settings: {
        codexAccounts: [],
        codexHomePath: "",
        localeOverride: localeState.locale,
        selectedCodexAccountId: "default",
      },
    }),
  };
});

import { MossLocalizationProvider } from "~/localization";
import { makeActivity } from "../../storeTestFixtures";
import { deriveWorkLogEntries } from "../../workLog";
import { TimelineWorkEntryRow } from "./TimelineWorkEntryRow";

const turnId = TurnId.makeUnsafe("turn-1");

// What the server stores for a failed MCP server: the sentence, plus Codex's own
// notification (server name and its error) as the activity's data.
function mcpStartupRow(message: string) {
  const [entry] = deriveWorkLogEntries(
    [
      makeActivity({
        id: "mcp-cloudflare",
        kind: "runtime.warning",
        tone: "info",
        summary: "Runtime warning",
        turnId: "turn-1",
        payload: {
          message,
          detail: message,
          data: {
            name: "cloudflare-api",
            status: "failed",
            error:
              "The cloudflare-api MCP server is not logged in. Run `codex mcp login cloudflare-api`.",
          },
        },
      }),
    ],
    turnId,
  );
  if (!entry) throw new Error("The MCP startup warning left no row.");
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MossLocalizationProvider>
        <TimelineWorkEntryRow
          workEntry={entry}
          chatMetaFontSizePx={12}
          density="default"
          markdownCwd={undefined}
          onImageExpand={() => undefined}
          timestampFormat="locale"
        />
      </MossLocalizationProvider>
    </QueryClientProvider>,
  );
}

describe("TimelineWorkEntryRow MCP startup failure", () => {
  it("reads as one Chinese sentence without a server-name heading or a command", () => {
    localeState.locale = "zh-CN";
    const markup = mcpStartupRow(
      'MCP server "cloudflare-api" is not signed in. Its tools are unavailable for now.',
    );

    expect(markup).toContain("MCP 连接器「cloudflare-api」未登录，相关工具暂不可用。");
    expect(markup).not.toContain("Cloudflare api");
    expect(markup).not.toContain("codex mcp login");
    expect(markup).not.toContain("MCP server");
  });

  it("reads as the same whole sentence in English", () => {
    localeState.locale = "en";
    const markup = mcpStartupRow(
      'MCP server "cloudflare-api" is not signed in. Its tools are unavailable for now.',
    );

    expect(markup).toContain(
      "MCP server &quot;cloudflare-api&quot; is not signed in. Its tools are unavailable for now.",
    );
    expect(markup).not.toContain("Cloudflare api");
  });
});
