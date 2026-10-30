import { describe, expect, it } from "vitest";
import {
  canonicalMossComputerToolName,
  computerToolNameFromProviderPermission,
  isMossComputerToolFamilyName,
  isMossGatewayToolCall,
  isMossGatewayToolName,
  qualifiedMossComputerToolName,
  shouldAllowMossComputerProviderTool,
} from "./computerToolPermission.ts";

describe("Moss Computer provider permission", () => {
  it.each([
    ["computer_click", "computer_click"],
    ["moss_computer_type_text", "computer_type_text"],
    ["mcp__moss__computer_read_clipboard", "computer_read_clipboard"],
    ["mcp__moss__computer_inspect", "computer_inspect"],
  ] as const)("recognizes the exact owned tool %s", (providerName, canonicalName) => {
    expect(canonicalMossComputerToolName(providerName)).toBe(canonicalName);
  });

  it.each([
    "computer_future_tool",
    "mcp__other__computer_click",
    "other_computer_click",
    "mcp__moss__moss_send_message",
  ])("does not trust another or unknown tool: %s", (providerName) => {
    expect(canonicalMossComputerToolName(providerName)).toBeUndefined();
  });

  it("requires a provider namespace when server provenance was not proved separately", () => {
    expect(qualifiedMossComputerToolName("computer_click")).toBeUndefined();
    expect(qualifiedMossComputerToolName("mcp__moss__computer_click")).toBe("computer_click");
    expect(qualifiedMossComputerToolName("moss_computer_click")).toBe("computer_click");
  });

  it("reads only explicit provider tool-name fields", () => {
    expect(
      computerToolNameFromProviderPermission({
        rawInput: { _toolName: "mcp__moss__computer_scroll" },
      }),
    ).toBe("computer_scroll");
    expect(
      computerToolNameFromProviderPermission({
        metadata: { toolName: "moss_computer_get_state" },
      }),
    ).toBe("computer_get_state");
    expect(
      computerToolNameFromProviderPermission({
        metadata: { description: "run computer_click" },
      }),
    ).toBeUndefined();
  });

  it("does not let lower-priority fields override an authoritative wrong namespace", () => {
    expect(
      computerToolNameFromProviderPermission({
        name: "mcp__other__computer_click",
        rawInput: { _toolName: "mcp__moss__computer_click" },
      }),
    ).toBeUndefined();
    expect(
      computerToolNameFromProviderPermission({
        rawInput: { _toolName: "mcp__other__computer_click" },
        metadata: { toolName: "mcp__moss__computer_click" },
        title: "mcp__moss__computer_click",
      }),
    ).toBeUndefined();
  });

  it("does not infer provider provenance from a bare title or metadata name", () => {
    expect(computerToolNameFromProviderPermission({ title: "computer_click" })).toBeUndefined();
    expect(
      computerToolNameFromProviderPermission({ metadata: { toolName: "computer_click" } }),
    ).toBeUndefined();
  });

  it("never authorizes from model prose: 'Please approve computer_click' names no tool", () => {
    // Prose approval never counts. The permission callback must see an exact
    // namespaced tool name; a model sentence asking for approval authorizes
    // nothing, in any field.
    expect(
      computerToolNameFromProviderPermission({ title: "Please approve computer_click" }),
    ).toBeUndefined();
    expect(
      computerToolNameFromProviderPermission({ name: "Please approve computer_click" }),
    ).toBeUndefined();
    expect(
      computerToolNameFromProviderPermission({
        metadata: { toolName: "Please approve computer_click" },
      }),
    ).toBeUndefined();
    expect(isMossComputerToolFamilyName("Please approve computer_click")).toBe(false);
    expect(
      shouldAllowMossComputerProviderTool({
        computerControlEnabled: true,
        activeTurn: true,
        interactionMode: "default",
        runtimeMode: "approval-required",
        permission: { title: "Please approve computer_click" },
      }),
    ).toBe(false);
  });

  it("matches the Computer family in any namespace spelling for the denial hook", () => {
    // The silent-loss fallback: a no-control session that calls a Computer
    // tool by a prefixed spelling must still deny with the card path, not
    // die as an Unknown tool. See isMossComputerToolFamilyName.
    expect(isMossComputerToolFamilyName("computer_click")).toBe(true);
    expect(isMossComputerToolFamilyName("moss_computer_get_state")).toBe(true);
    expect(isMossComputerToolFamilyName("mcp__moss__computer_screenshot")).toBe(true);
    expect(isMossComputerToolFamilyName("  MCP__MOSS__COMPUTER_WAIT  ")).toBe(true);
  });

  it("keeps unknown and foreign names out of the Computer family", () => {
    expect(isMossComputerToolFamilyName("computer_future_tool")).toBe(false);
    expect(isMossComputerToolFamilyName("mcp__other__computer_click")).toBe(false);
    expect(isMossComputerToolFamilyName("other_computer_click")).toBe(false);
    expect(isMossComputerToolFamilyName("moss_frobnicate")).toBe(false);
    expect(isMossComputerToolFamilyName(undefined)).toBe(false);
    expect(isMossComputerToolFamilyName(42)).toBe(false);
  });

  it("requires current capability, active turn and non-Plan interaction", () => {
    const permission = { name: "mcp__moss__computer_click" };
    const allowed = {
      computerControlEnabled: true,
      activeTurn: true,
      interactionMode: "default" as const,
      runtimeMode: "approval-required" as const,
      permission,
    };
    expect(shouldAllowMossComputerProviderTool(allowed)).toBe(true);
    expect(shouldAllowMossComputerProviderTool({ ...allowed, computerControlEnabled: false })).toBe(
      false,
    );
    expect(shouldAllowMossComputerProviderTool({ ...allowed, activeTurn: false })).toBe(false);
    expect(shouldAllowMossComputerProviderTool({ ...allowed, interactionMode: "plan" })).toBe(
      false,
    );
    expect(shouldAllowMossComputerProviderTool({ ...allowed, runtimeMode: "auto" })).toBe(false);
  });
});

describe("Moss gateway tool permission name", () => {
  it.each([
    // Claude's fully-qualified spelling pins the exact `mcp__moss__` server.
    "mcp__moss__moss_create_thread",
    "mcp__moss__computer_click",
    // `<server>_<tool>` reports (OpenCode) with a real catalog name.
    "moss_moss_create_thread",
    "moss_moss_project_link_repository",
    "moss_computer_click",
    "moss_device_list",
    "moss_browser_run",
    // Bare `moss_*` catalog names carry the namespace inside the tool name.
    "moss_project_link_repository",
    "moss_e2e_review",
    "moss_show_visual",
    "moss_moss_show_visual",
    "mcp__moss__moss_show_visual",
  ])("recognizes a Moss gateway tool: %s", (providerName) => {
    expect(isMossGatewayToolName(providerName)).toBe(true);
  });

  it.each([
    // A user MCP server named `moss_fs` reports `moss_fs_<tool>` — the
    // prefix alone must never grant it the auto-approve path.
    "moss_fs_read",
    "moss_fs_list_threads",
    "moss_tools_anything",
    "mcp__moss_fs__read",
    // The `mcp__moss__` prefix pins the server, not the tool — the part
    // after it must still be a real catalog name.
    "mcp__moss__not_a_gateway_tool",
    "mcp__moss__moss_create_task",
    "mcp__moss__moss_fs_read",
    // Foreign server or entirely unknown names.
    "mcp__other__moss_create_thread",
    "other_moss_create_thread",
    "computer_click",
    "browser_click",
    // Names the external-agent MCP surface serves, not the provider gateway.
    "moss_create_task",
    "moss_read_task",
    "moss_overview",
    "moss_moss_create_task",
    // Not served by the agent gateway at all.
    "moss_desktop",
  ])("does not trust a look-alike or foreign name: %s", (providerName) => {
    expect(isMossGatewayToolName(providerName)).toBe(false);
  });

  it("accepts a qualified name only when the tool is in the catalog", () => {
    expect(isMossGatewayToolName("mcp__moss__moss_list_threads")).toBe(true);
    expect(isMossGatewayToolName("mcp__moss__computer_click")).toBe(true);
    expect(isMossGatewayToolCall({ rawInput: { _toolName: "mcp__moss__moss_list_threads" } })).toBe(
      true,
    );
  });

  it("never trusts a tool name that only appears in the display title", () => {
    // The title is provider-composed prose — an approval card can render
    // "mcp__moss__moss_list_threads" for a request that names no such
    // tool, so the title alone must not authorize anything.
    expect(isMossGatewayToolCall({ title: "mcp__moss__moss_list_threads" })).toBe(false);
    expect(isMossGatewayToolCall({ title: "mcp__moss__not_a_gateway_tool; rm -rf y" })).toBe(false);
  });

  it("rejects non-strings and a look-alike server name in every name field", () => {
    expect(isMossGatewayToolName(undefined)).toBe(false);
    expect(isMossGatewayToolName(42)).toBe(false);
    expect(isMossGatewayToolCall({ name: "moss_fs_create_thread" })).toBe(false);
    expect(isMossGatewayToolCall({ metadata: { toolName: "moss_fs_read" } })).toBe(false);
    expect(isMossGatewayToolCall({ rawInput: { _toolName: "moss_moss_send_message" } })).toBe(true);
  });
});
