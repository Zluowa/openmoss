import { describe, expect, it } from "vitest";

import { toolRowBrandIcon, toolRowIcon } from "./toolRowIcon";

const icon = (input: Parameters<typeof toolRowIcon>[0]) =>
  toolRowBrandIcon(input) ?? toolRowIcon(input);

describe("tool row icon, one choice for desktop and phone", () => {
  it("gives git and gh commands the GitHub mark, also inside a shell wrapper", () => {
    expect(icon({ itemType: "command_execution", command: "git status" })).toBe("github");
    expect(icon({ itemType: "commandExecution", command: "gh pr view 12" })).toBe("github");
    expect(
      icon({ itemType: "command_execution", command: `/bin/zsh -lc "cd /repo && git log -3"` }),
    ).toBe("github");
    expect(icon({ itemType: "command_execution", command: "bun run test" })).toBe("terminal");
    expect(icon({ itemType: "command_execution", command: "cat README.md" })).toBe("file");
  });

  it("gives an image generation the zap and a viewed image the eye", () => {
    expect(icon({ itemType: "image_generation" })).toBe("zap");
    expect(icon({ itemType: "imageGeneration" })).toBe("zap");
    expect(icon({ itemType: "image_view" })).toBe("eye");
  });

  it("marks MCP tools: Moss's own with the Moss mark, other servers with the MCP mark", () => {
    expect(icon({ itemType: "mcp_tool_call", toolName: "mcp__moss__moss_context" })).toBe("moss");
    expect(icon({ itemType: "mcp_tool_call", toolName: "mcp__notion__search_pages" })).toBe("mcp");
    expect(icon({ itemType: "mcp_tool_call", toolName: "mcp__codex_apps__github_pr" })).toBe(
      "github",
    );
    expect(icon({ itemType: "mcp_tool_call", toolName: "mcp__moss__computer_click" })).toBe(
      "computer-use",
    );
    expect(icon({ itemType: "mcp_tool_call", toolName: "mcp__moss__browser_open" })).toBe("globe");
  });

  it("follows what a provider tool is, not its bucket", () => {
    expect(icon({ itemType: "dynamic_tool_call", toolName: "Read" })).toBe("file");
    expect(icon({ itemType: "dynamic_tool_call", toolName: "Grep" })).toBe("search");
    expect(icon({ itemType: "dynamic_tool_call", toolName: "TodoWrite" })).toBe("hammer");
    expect(icon({ itemType: "web_search" })).toBe("web-search");
    expect(icon({ itemType: "file_change" })).toBe("pencil");
    expect(icon({ itemType: "collab_agent_tool_call" })).toBe("agent");
    expect(icon({ itemType: "reasoning" })).toBeNull();
  });
});
