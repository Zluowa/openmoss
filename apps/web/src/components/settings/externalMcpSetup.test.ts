import { describe, expect, it } from "vitest";

import {
  EXTERNAL_MCP_CLIENTS,
  EXTERNAL_MCP_SERVER_NAME,
  buildExternalMcpClientConfiguration,
  buildExternalMcpExamplePrompt,
  buildExternalMcpSetupPrompt,
  describeExternalMcpPermissions,
  externalMcpSetupAction,
} from "./externalMcpSetup";

const stdio = {
  command: "/Applications/Moss.app/Contents/MacOS/Moss",
  args: [
    "server.js",
    "mcp",
    "serve",
    "--integration",
    "mcp_int_example",
    "--home-dir",
    "/tmp/Moss home",
  ],
  env: { ELECTRON_RUN_AS_NODE: "1" },
};

describe("external MCP guided setup", () => {
  it("builds copyable Codex and Claude Code commands without embedding a credential", () => {
    const codex = buildExternalMcpClientConfiguration("codex", stdio);
    const claude = buildExternalMcpClientConfiguration("claudeCode", stdio);

    expect(codex.value).toBe(
      `codex mcp add ${EXTERNAL_MCP_SERVER_NAME} --env ELECTRON_RUN_AS_NODE=1 -- /Applications/Moss.app/Contents/MacOS/Moss server.js mcp serve --integration mcp_int_example --home-dir '/tmp/Moss home'`,
    );
    expect(claude.value).toBe(
      `claude mcp add --scope user ${EXTERNAL_MCP_SERVER_NAME} -e ELECTRON_RUN_AS_NODE=1 -- /Applications/Moss.app/Contents/MacOS/Moss server.js mcp serve --integration mcp_int_example --home-dir '/tmp/Moss home'`,
    );
    expect(`${codex.instruction}${claude.instruction}`).toContain("Moss");
    expect(codex.value).not.toContain("mcp add moss ");
    expect(claude.value).not.toContain(" user moss ");
    expect(`${codex.value}${claude.value}`).not.toContain("syn_mcp_v1_");
  });

  it("builds standard JSON configuration for desktop and other clients", () => {
    const desktop = buildExternalMcpClientConfiguration("claudeDesktop", stdio);
    const parsed = JSON.parse(desktop.value) as {
      mcpServers: Record<string, { command: string; args: ReadonlyArray<string> }>;
    };

    expect(desktop.format).toBe("json");
    expect(parsed.mcpServers[EXTERNAL_MCP_SERVER_NAME]).toEqual(stdio);
    expect(parsed.mcpServers.moss).toBeUndefined();
    expect(desktop.instruction).toContain("Moss");
  });

  it("builds terminal commands for PowerShell on Windows", () => {
    const codex = buildExternalMcpClientConfiguration("codex", stdio, "Win32");
    expect(codex.value).toBe(
      `& 'codex' 'mcp' 'add' '${EXTERNAL_MCP_SERVER_NAME}' '--env' 'ELECTRON_RUN_AS_NODE=1' '--' '/Applications/Moss.app/Contents/MacOS/Moss' 'server.js' 'mcp' 'serve' '--integration' 'mcp_int_example' '--home-dir' '/tmp/Moss home'`,
    );
    expect(codex.instruction).toContain("PowerShell");
  });

  it("builds a project-specific prompt without exposing implementation identifiers", () => {
    const prompt = buildExternalMcpExamplePrompt("Moss app");

    expect(prompt).toContain('project named "Moss app"');
    expect(prompt).toContain("managed worktree");
    expect(prompt).toContain("approval-required");
    expect(prompt).toContain("Use Moss");
    expect(prompt).not.toContain("projectId");
    expect(prompt).not.toContain("request ID");
    expect(prompt).not.toContain("mcp_int_");
  });

  it("uses Moss in generated client-facing setup copy", () => {
    const copy = Object.values(EXTERNAL_MCP_CLIENTS)
      .map((client) => client.description)
      .join(" ");
    expect(copy).toContain("Moss");
  });

  it("builds one agent-facing setup prompt covering pairing, registration, and verification", () => {
    const prompt = buildExternalMcpSetupPrompt({
      setupCommand: "moss mcp pair --code syn_pair_v1_example --home-dir /tmp/home",
      stdio,
    });

    expect(prompt).toContain("syn_pair_v1_example");
    expect(prompt).toContain(`codex mcp add ${EXTERNAL_MCP_SERVER_NAME}`);
    expect(prompt).toContain(`claude mcp add --scope user ${EXTERNAL_MCP_SERVER_NAME}`);
    expect(prompt).toContain('"mcpServers"');
    expect(prompt).toContain("moss_overview");
    expect(prompt).not.toContain("syn_mcp_v1_");
  });

  it("omits the pairing step once the computer is already paired", () => {
    const prompt = buildExternalMcpSetupPrompt({ setupCommand: null, stdio });

    expect(prompt).toContain("already completed");
    expect(prompt).not.toContain("syn_pair_v1_");
    expect(prompt).toContain("moss_overview");
  });

  it("builds a discovery-first example prompt for all-projects connections", () => {
    const prompt = buildExternalMcpExamplePrompt(null);

    expect(prompt).toContain("moss_overview");
    expect(prompt).toContain("managed worktree");
    expect(prompt).toContain("Use Moss");
  });

  it("describes scopes without exposing capability identifiers", () => {
    const description = describeExternalMcpPermissions([
      "projects:read",
      "tasks:create",
      "tasks:wait",
      "tasks:read",
      "diagnostics:read",
      "runtime:local",
    ]);

    expect(description).toBe(
      "Create and follow its own tasks · Read redacted desktop diagnostics · Use the shared local checkout",
    );
    expect(description).not.toContain("runtime:local");
  });

  it("offers a non-destructive resume path when only the pairing code expired", () => {
    expect(
      externalMcpSetupAction({
        revoked: false,
        integrationExpired: false,
        paired: false,
        pairingExpired: true,
      }),
    ).toBe("resume-pairing");
    expect(
      externalMcpSetupAction({
        revoked: false,
        integrationExpired: true,
        paired: false,
        pairingExpired: true,
      }),
    ).toBe("revoke");
  });
});
