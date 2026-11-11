# MCP Apps fixture server (交互式连接器)

A dependency-free MCP server for testing Moss's interactive connectors. It is what the server
integration tests run against, and what acceptance runs point a dev Moss at.

| Piece                        | What it is                                                                                                                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fixture_show_widget`        | UI tool, `_meta.ui.resourceUri = ui://fixture/widget.html`, visibility `["model","app"]`, read-only. Returns text, `structuredContent {greeting, count, items}` and a result `_meta` that includes `moss/…` and `anthropic/…` keys (a host must strip them). |
| `fixture_app_increment`      | Widget-only tool (`["app"]`), not read-only, so it needs approval outside full access.                                                                                                                                                                       |
| `fixture_app_read`           | Widget-only, read-only tool.                                                                                                                                                                                                                                 |
| `fixture_model_only`         | Model-only tool (`["model"]`); a widget call must be refused.                                                                                                                                                                                                |
| `fixture_bad_structured`     | Returns `structuredContent` that is an array; a host must not hand it to a widget.                                                                                                                                                                           |
| `ui://fixture/widget.html`   | The widget. Resource-level `_meta.ui`: `csp` (connect + resource domains), `permissions.clipboardWrite`, `prefersBorder: true`, `domain` (opts a Moss connector into the stable origin).                                                                     |
| `fixture://files/report.txt` | A text resource for `resources/read` and `ui/download-file` resource links.                                                                                                                                                                                  |
| templates, prompts           | `resources/templates/list` and `prompts/list` answer with one entry each.                                                                                                                                                                                    |

The widget (`widget.html`) is built on the `@modelcontextprotocol/ext-apps` 1.7.5 `App` SDK, which
the server reads from the repo's `node_modules` at run time (it is never copied into the repo). On
load it calls a widget-only tool, a model-only tool (refused), an unknown tool (refused),
`resources/list`, `resources/read`, `ui/update-model-context` and logging; its buttons cover a
widget tool call that needs approval, `ui/request-display-mode`, `ui/message`, `ui/open-link` and
`ui/download-file`. Every outcome is listed in the widget and in `window.__results`.

## Running it

```sh
node apps/server/test-fixtures/mcp-apps/server.mjs                # stdio
node apps/server/test-fixtures/mcp-apps/server.mjs --http 47900   # http://127.0.0.1:47900/mcp
# add --trace <file.jsonl> (or MOSS_MCP_APPS_FIXTURE_TRACE) to log every request and answer
```

## Pointing a dev Moss at it

Start the dev Moss isolated as `D:\ceshi\moss-codex-handoff\testing.md` says (HOME, USERPROFILE,
APPDATA, LOCALAPPDATA, MOSS*HOME, CODEX_HOME, CLAUDE_CONFIG_DIR → the run folder; the three
`MOSS_DISABLE*\*` switches; fake keys; a local stub model gateway). Then pick a lane:

- **Claude (a CLI-own server).** In the chat's project folder add `.mcp.json`:
  `{"mcpServers":{"fixture":{"type":"stdio","command":"node","args":["<repo>/apps/server/test-fixtures/mcp-apps/server.mjs"]}}}`
  and approve it for the project (or `enableAllProjectMcpServers: true` in the isolated
  `.claude/settings.local.json`). Moss learns the tool definitions from the Agent SDK after `init`,
  reads the widget with `readMcpResource`, and runs widget tool calls with `mcp_call`.
- **Codex (a CLI-own server).** In the isolated `CODEX_HOME/config.toml`:
  `[mcp_servers.fixture]` with `command = "node"` and `args = ["<repo>/apps/server/test-fixtures/mcp-apps/server.mjs"]`.
  Codex reports the widget as `mcpAppUi` on the item; Moss reads it with `mcpServer/resource/read`
  and calls tools with `mcpServer/tool/call`.
- **Moss connector (any provider).** Connectors accept only public `https://` URLs (the proxy
  refuses loopback by design), so run `--http <port>` behind an HTTPS tunnel you control and add
  its URL in Settings → Connectors. Moss then lists, reads and calls through its own client with
  the stored credentials, and the widget gets the connector-stable origin (the resource declares
  `_meta.ui.domain`).

Never point the fixture at a signed-in production account: widget `ui/message` can send a real
turn.
