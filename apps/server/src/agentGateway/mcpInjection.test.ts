import { assert, describe, it } from "@effect/vitest";

import {
  appendCodexConfigSection,
  configHasTomlTableHeader,
  extractManagedCodexConfigSection,
  mergeShellEnvPolicyExclude,
  MOSS_MANAGED_CODEX_CONFIG_BEGIN,
  MOSS_MANAGED_CODEX_CONFIG_END,
} from "../codexProcessEnv.ts";
import {
  buildAntigravityMcpPluginConfig,
  buildAcpMossMcpServers,
  buildClaudeMcpServers,
  buildCodexMcpConfigToml,
  buildCodexMcpThreadConfig,
  buildOpenCodeConnectorMcpServers,
  buildOpenCodeMcpServer,
  callAgentGatewayMcpTool,
  listAgentGatewayMcpTools,
  MOSS_AGENT_GATEWAY_BOOTSTRAP_TOKEN_ENV,
  MOSS_AGENT_GATEWAY_TOKEN_ENV,
  MOSS_MCP_TOOL_TIMEOUT_MS,
} from "./mcpInjection.ts";

const connection = {
  url: "http://127.0.0.1:3773/mcp",
  bearerToken: "sagw_abc.def",
};

const stdioProxy = {
  command: "/usr/local/bin/node",
  args: ["/state/agent-gateway-mcp-proxy.mjs"],
};

describe("agent gateway MCP injection", () => {
  it("builds a secret-free Antigravity stdio plugin config", () => {
    assert.deepEqual(buildAntigravityMcpPluginConfig(stdioProxy), {
      mcpServers: {
        moss: {
          command: stdioProxy.command,
          args: stdioProxy.args,
          env: {
            MOSS_AGENT_GATEWAY_URL: "$MOSS_AGENT_GATEWAY_URL",
            MOSS_AGENT_GATEWAY_BOOTSTRAP_TOKEN: "$MOSS_AGENT_GATEWAY_BOOTSTRAP_TOKEN",
            ELECTRON_RUN_AS_NODE: "1",
          },
          disabled: false,
          disabledTools: [],
        },
      },
    });
  });

  it("builds a codex config block that references the token env var, not the token", () => {
    const block = buildCodexMcpConfigToml(connection.url);
    assert.include(block, "[mcp_servers.moss]");
    assert.include(block, `url = "${connection.url}"`);
    assert.include(block, `bearer_token_env_var = "${MOSS_AGENT_GATEWAY_TOKEN_ENV}"`);
    assert.notInclude(block, connection.bearerToken);
  });

  it("lets Moss tool calls outlast Codex's default 60s timeout", () => {
    assert.include(buildCodexMcpConfigToml(connection.url), "tool_timeout_sec = 3900");
    assert.strictEqual(
      buildCodexMcpThreadConfig(connection).mcp_servers.moss?.tool_timeout_sec,
      MOSS_MCP_TOOL_TIMEOUT_MS / 1_000,
    );
  });

  it("appends the codex section once and keeps existing config intact", () => {
    const base = '[model]\nname = "gpt-5.5"\n';
    const section = buildCodexMcpConfigToml(connection.url);
    const appended = appendCodexConfigSection(base, section);
    assert.include(appended, '[model]\nname = "gpt-5.5"');
    assert.include(appended, "[mcp_servers.moss]");

    const reappended = appendCodexConfigSection(appended, section);
    assert.equal(reappended.split("[mcp_servers.moss]").length, 2);
  });

  it("merges the token exclusion into a user-defined shell environment policy", () => {
    const withExclude = [
      "[shell_environment_policy]",
      'exclude = ["AWS_*"]',
      "",
      "[model]",
      'name = "gpt-5.5"',
    ].join("\n");
    const merged = mergeShellEnvPolicyExclude(withExclude, MOSS_AGENT_GATEWAY_TOKEN_ENV);
    assert.include(merged, `exclude = ["${MOSS_AGENT_GATEWAY_TOKEN_ENV}", "AWS_*"]`);

    // Idempotent: the var is not added twice.
    assert.equal(mergeShellEnvPolicyExclude(merged, MOSS_AGENT_GATEWAY_TOKEN_ENV), merged);

    // A policy table without an exclude key gains one.
    const withoutExclude = ["[shell_environment_policy]", 'inherit = "core"'].join("\n");
    const gained = mergeShellEnvPolicyExclude(withoutExclude, MOSS_AGENT_GATEWAY_TOKEN_ENV);
    assert.include(gained, `exclude = ["${MOSS_AGENT_GATEWAY_TOKEN_ENV}"]`);
    assert.include(gained, 'inherit = "core"');

    // No policy table: unchanged (the managed section appends its own).
    assert.equal(
      mergeShellEnvPolicyExclude('[model]\nname = "gpt-5.5"', MOSS_AGENT_GATEWAY_TOKEN_ENV),
      '[model]\nname = "gpt-5.5"',
    );
  });

  it("ignores commented and unrelated token references when merging shell exclusions", () => {
    const commentedExample = [
      "[shell_environment_policy]",
      `# exclude = ["${MOSS_AGENT_GATEWAY_TOKEN_ENV}"]`,
      'exclude = ["AWS_*"]',
    ].join("\n");
    const mergedCommentedExample = mergeShellEnvPolicyExclude(
      commentedExample,
      MOSS_AGENT_GATEWAY_TOKEN_ENV,
    );
    assert.include(
      mergedCommentedExample,
      `exclude = ["${MOSS_AGENT_GATEWAY_TOKEN_ENV}", "AWS_*"]`,
    );

    const unrelatedString = [
      "[shell_environment_policy]",
      `note = "keep ${MOSS_AGENT_GATEWAY_TOKEN_ENV} private"`,
      'exclude = ["AWS_*"]',
    ].join("\n");
    const mergedUnrelatedString = mergeShellEnvPolicyExclude(
      unrelatedString,
      MOSS_AGENT_GATEWAY_TOKEN_ENV,
    );
    assert.include(mergedUnrelatedString, `exclude = ["${MOSS_AGENT_GATEWAY_TOKEN_ENV}", "AWS_*"]`);
  });

  it("recognizes only active exact entries in multiline shell exclusion arrays", () => {
    const existing = [
      "[shell_environment_policy]",
      "exclude = [",
      '  "AWS_*",',
      `  "${MOSS_AGENT_GATEWAY_TOKEN_ENV}",`,
      "]",
    ].join("\n");
    assert.equal(mergeShellEnvPolicyExclude(existing, MOSS_AGENT_GATEWAY_TOKEN_ENV), existing);

    const tokenOnlyInComment = [
      "[shell_environment_policy]",
      "exclude = [",
      `  # "${MOSS_AGENT_GATEWAY_TOKEN_ENV}",`,
      '  "AWS_*",',
      "]",
    ].join("\n");
    const merged = mergeShellEnvPolicyExclude(tokenOnlyInComment, MOSS_AGENT_GATEWAY_TOKEN_ENV);
    assert.include(merged, `exclude = ["${MOSS_AGENT_GATEWAY_TOKEN_ENV}",`);
  });

  it("detects real TOML table headers, ignoring comments and strings", () => {
    assert.isTrue(configHasTomlTableHeader('[mcp_servers.moss]\nurl = "x"', "[mcp_servers.moss]"));
    assert.isTrue(
      configHasTomlTableHeader("  [mcp_servers.moss]  # managed", "[mcp_servers.moss]"),
    );
    assert.isTrue(
      configHasTomlTableHeader("  [ mcp_servers.moss ]  # managed", "[mcp_servers.moss]"),
    );
    assert.isTrue(configHasTomlTableHeader("  [ mcp_servers . moss ]", "[mcp_servers.moss]"));
    assert.isTrue(configHasTomlTableHeader('[mcp_servers."moss"]', "[mcp_servers.moss]"));
    assert.isTrue(configHasTomlTableHeader("['mcp_servers'.'moss']", "[mcp_servers.moss]"));
    assert.isTrue(
      configHasTomlTableHeader('[mcp_servers."syn\\u0061ra"]', "[mcp_servers.syn\u0061ra]"),
    );
    assert.isTrue(
      configHasTomlTableHeader('["shell_environment_policy"]', "[shell_environment_policy]"),
    );
    assert.isFalse(configHasTomlTableHeader('["mcp_servers.moss"]', "[mcp_servers.moss]"));
    assert.isFalse(configHasTomlTableHeader('[mcp_servers."syn\\qara"]', "[mcp_servers.moss]"));
    // A commented-out example block must not count as the table being present.
    assert.isFalse(configHasTomlTableHeader("# [mcp_servers.moss]", "[mcp_servers.moss]"));
    assert.isFalse(
      configHasTomlTableHeader('note = "see [mcp_servers.moss] docs"', "[mcp_servers.moss]"),
    );
  });

  it("round-trips the managed section through the overlay markers", () => {
    const section = buildCodexMcpConfigToml(connection.url);
    const overlayConfig = [
      '[model]\nname = "gpt-5.5"',
      "",
      MOSS_MANAGED_CODEX_CONFIG_BEGIN,
      section,
      MOSS_MANAGED_CODEX_CONFIG_END,
      "",
    ].join("\n");
    // A rewrite without appendConfigToml recovers the block so concurrent env
    // preps (version checks, text generation) don't strip the session's MCP entry.
    assert.equal(extractManagedCodexConfigSection(overlayConfig), section);
    assert.isUndefined(extractManagedCodexConfigSection('[model]\nname = "gpt-5.5"\n'));
  });

  it("builds a claude http server entry with the bearer header", () => {
    const servers = buildClaudeMcpServers(connection);
    assert.deepEqual(servers, {
      moss: {
        type: "http",
        url: connection.url,
        headers: { Authorization: `Bearer ${connection.bearerToken}` },
        timeout: MOSS_MCP_TOOL_TIMEOUT_MS,
      },
    });
  });

  it("builds an authenticated OpenCode remote MCP config with OAuth disabled", () => {
    assert.deepEqual(buildOpenCodeMcpServer(connection), {
      type: "remote",
      url: connection.url,
      enabled: true,
      headers: { Authorization: `Bearer ${connection.bearerToken}` },
      oauth: false,
    });
  });

  it("loads and invokes the canonical gateway catalog for native-tool providers", async () => {
    const requests: Array<{ readonly authorization: string | null; readonly body: unknown }> = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      const body: unknown = JSON.parse(String(init?.body));
      requests.push({
        authorization: new Headers(init?.headers).get("Authorization"),
        body,
      });
      const request = body as { readonly id: string; readonly method: string };
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result:
          request.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "moss_list_threads",
                    description: "List Moss threads.",
                    inputSchema: { type: "object", properties: {} },
                  },
                ],
              }
            : { content: [{ type: "text", text: "ok" }] },
      });
    };

    assert.deepEqual(await listAgentGatewayMcpTools({ connection, fetch }), [
      {
        name: "moss_list_threads",
        description: "List Moss threads.",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    assert.deepEqual(
      await callAgentGatewayMcpTool({
        connection,
        name: "moss_list_threads",
        arguments: { limit: 2 },
        fetch,
      }),
      { content: [{ type: "text", text: "ok" }] },
    );
    assert.deepEqual(
      requests.map((request) => request.authorization),
      [`Bearer ${connection.bearerToken}`, `Bearer ${connection.bearerToken}`],
    );
    assert.deepEqual((requests[1]?.body as { readonly params: unknown }).params, {
      name: "moss_list_threads",
      arguments: { limit: 2 },
    });
  });

  it("uses the ACP http transport when the agent advertises support", () => {
    const servers = buildAcpMossMcpServers({
      connection,
      initializeResult: { agentCapabilities: { mcpCapabilities: { http: true } } },
      stdioProxy,
      issueStdioBootstrapToken: () => null,
    });
    assert.deepEqual(servers, [
      {
        type: "http",
        name: "moss",
        url: connection.url,
        headers: [{ name: "Authorization", value: `Bearer ${connection.bearerToken}` }],
      },
    ]);
  });

  it("falls back to a Node-mode stdio proxy when http is not advertised", () => {
    const servers = buildAcpMossMcpServers({
      connection,
      initializeResult: {},
      stdioProxy,
      issueStdioBootstrapToken: () => "bootstrap-token-1",
    });
    assert.deepEqual(servers, [
      {
        name: "moss",
        command: stdioProxy.command,
        args: stdioProxy.args,
        env: [
          { name: "MOSS_AGENT_GATEWAY_URL", value: connection.url },
          { name: MOSS_AGENT_GATEWAY_BOOTSTRAP_TOKEN_ENV, value: "bootstrap-token-1" },
          { name: "ELECTRON_RUN_AS_NODE", value: "1" },
        ],
      },
    ]);
  });
});

describe("connector injection", () => {
  const withConnectors = {
    ...connection,
    connectors: [
      {
        name: "supabase_connector",
        url: "http://127.0.0.1:3773/mcp/connectors/mcp_conn_1",
      },
    ],
  };
  const authorization = `Bearer ${connection.bearerToken}`;

  it("adds connector proxies to Claude next to moss, with the session bearer", () => {
    assert.deepEqual(buildClaudeMcpServers(withConnectors), {
      moss: {
        type: "http",
        url: connection.url,
        headers: { Authorization: authorization },
        timeout: MOSS_MCP_TOOL_TIMEOUT_MS,
      },
      supabase_connector: {
        type: "http",
        url: "http://127.0.0.1:3773/mcp/connectors/mcp_conn_1",
        headers: { Authorization: authorization },
      },
    });
  });

  it("adds connector proxies only to Codex's per-thread config", () => {
    assert.deepEqual(buildCodexMcpThreadConfig(withConnectors), {
      mcp_servers: {
        moss: {
          url: connection.url,
          http_headers: { Authorization: authorization },
          tool_timeout_sec: MOSS_MCP_TOOL_TIMEOUT_MS / 1_000,
        },
        supabase_connector: {
          url: "http://127.0.0.1:3773/mcp/connectors/mcp_conn_1",
          http_headers: { Authorization: authorization },
        },
      },
    });
    assert.notInclude(buildCodexMcpConfigToml(connection.url, "thread"), "connector");
  });

  it("adds connectors for HTTP-capable ACP agents and omits them over stdio", () => {
    const http = buildAcpMossMcpServers({
      connection: withConnectors,
      initializeResult: { agentCapabilities: { mcpCapabilities: { http: true } } },
      stdioProxy,
      issueStdioBootstrapToken: () => null,
    });
    assert.deepEqual(
      http.map((server) => server.name),
      ["moss", "supabase_connector"],
    );
    const stdio = buildAcpMossMcpServers({
      connection: withConnectors,
      initializeResult: {},
      stdioProxy,
      issueStdioBootstrapToken: () => "bootstrap-token-1",
    });
    assert.deepEqual(
      stdio.map((server) => server.name),
      ["moss"],
    );
  });

  it("builds OpenCode remote entries for connectors with OAuth disabled", () => {
    assert.deepEqual(buildOpenCodeConnectorMcpServers(withConnectors), [
      {
        name: "supabase_connector",
        config: {
          type: "remote",
          url: "http://127.0.0.1:3773/mcp/connectors/mcp_conn_1",
          enabled: true,
          headers: { Authorization: authorization },
          oauth: false,
        },
      },
    ]);
    assert.deepEqual(buildOpenCodeConnectorMcpServers(connection), []);
  });
});
