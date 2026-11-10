import { describe, expect, it } from "vitest";

import { mossCodexWebSearchMode, withMossCodexWebSearchMode } from "./codexMossWebSearch.ts";

describe("mossCodexWebSearchMode", () => {
  it("turns hosted search off for Moss threads outside full access", () => {
    expect(mossCodexWebSearchMode({ accountId: "moss", runtimeMode: "approval-required" })).toBe(
      "disabled",
    );
    expect(mossCodexWebSearchMode({ accountId: "moss", runtimeMode: "auto" })).toBe("disabled");
  });

  it("keeps Codex's own live default in full access", () => {
    expect(
      mossCodexWebSearchMode({ accountId: "moss", runtimeMode: "full-access" }),
    ).toBeUndefined();
  });

  it("leaves the person's own Codex accounts alone", () => {
    expect(
      mossCodexWebSearchMode({ accountId: undefined, runtimeMode: "approval-required" }),
    ).toBeUndefined();
    expect(
      mossCodexWebSearchMode({ accountId: "work", runtimeMode: "approval-required" }),
    ).toBeUndefined();
  });

  it("adds the mode to the thread's other overrides without dropping them", () => {
    const mcp = { mcp_servers: { moss: { url: "http://127.0.0.1:1/mcp", http_headers: {} } } };
    expect(
      withMossCodexWebSearchMode(mcp, { accountId: "moss", runtimeMode: "approval-required" }),
    ).toEqual({ ...mcp, web_search: "disabled" });
    expect(withMossCodexWebSearchMode(mcp, { accountId: "moss", runtimeMode: "full-access" })).toBe(
      mcp,
    );
    expect(
      withMossCodexWebSearchMode(undefined, { accountId: "moss", runtimeMode: "auto" }),
    ).toEqual({ web_search: "disabled" });
  });
});
