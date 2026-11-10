import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import {
  localRepairEnvironment,
  runLocalCodex,
  validateLocalCodexConfig,
} from "./devsLocalExecutor";

describe("local Magpie execution boundaries", () => {
  it("keeps native Windows runtime fields and credentialless local network proxies", () => {
    expect(
      localRepairEnvironment({
        SystemDrive: "C:",
        USERNAME: "worker",
        HTTPS_PROXY: "http://127.0.0.1:7897",
        HTTP_PROXY: "http://user:pass@localhost:7897",
        ALL_PROXY: "http://external.test",
      }),
    ).toEqual({ SystemDrive: "C:", USERNAME: "worker", HTTPS_PROXY: "http://127.0.0.1:7897" });
  });
  it("passes native runtime paths but strips keys and inherited agent identity", () => {
    expect(
      localRepairEnvironment({
        Path: "tools",
        SystemRoot: "windows",
        HOME: "/user",
        OPENAI_API_KEY: "private",
        MOSS_DEVS_GITHUB_TOKEN: "private",
        CODEX_THREAD_ID: "parent",
        CODEX_HOME: "/personal",
      }),
    ).toEqual({ Path: "tools", SystemRoot: "windows", HOME: "/user" });
  });
  it.each([
    "http://external.test",
    "http://127.0.0.1:3425/v1",
    "http://user:pass@localhost:3425",
    "http://localhost?key=private",
    "file:///tmp",
  ])("refuses an unsafe or ambiguous gateway %s", (magpieUrl) => {
    expect(() =>
      validateLocalCodexConfig({ executable: "codex", model: "codex/test", magpieUrl }),
    ).toThrow();
  });

  // Codex 0.166 offers every tool to current models only through code mode's exec tool. A real
  // 0.166 turn with this config (exec listing ALL_TOOLS) reached apply_patch, the goal and MCP
  // resource tools and moss_workspace, and no exec_command or shell, even though `codex features
  // list` reports unified_exec as on. These settings are what keeps it that way.
  it("writes a repair config whose only tools are the checkout's moss_workspace and patching", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "moss-devs-config-"));
    try {
      const calls: { file: string; args: readonly string[] }[] = [];
      await runLocalCodex(
        { executable: "codex", model: "codex/test", magpieUrl: "http://127.0.0.1:3425/" },
        { id: "report-1", engine: "codex", description: "d", context: "c" },
        { cwd: runtimeDir, runtimeDir, prompt: "fix it", timeoutMs: 1_000 },
        (file, args) => {
          calls.push({ file, args });
          return Promise.resolve("");
        },
      );
      const config = parseToml(
        await fs.readFile(path.join(runtimeDir, "report-1", "config.toml"), "utf8"),
      ) as Record<string, any>;

      expect(config.web_search).toBe("disabled");
      expect(config.allow_login_shell).toBe(false);
      expect(config.features).toMatchObject({
        shell_tool: false,
        unified_exec: false,
        // Without the host the agent cannot reach moss_workspace at all (job 0eafa169).
        code_mode_host: true,
        multi_agent: false,
        view_image: false,
        image_generation: false,
        browser_use: false,
        browser_use_external: false,
        in_app_browser: false,
        computer_use: false,
        hooks: false,
        apps: false,
        plugins: false,
        remote_plugin: false,
        tool_suggest: false,
        memories: false,
      });
      expect(config.sandbox_workspace_write).toMatchObject({ network_access: false });
      expect(Object.keys(config.mcp_servers)).toEqual(["moss_workspace"]);
      expect(config.mcp_servers.moss_workspace.enabled_tools).toEqual([
        "list_files",
        "read_file",
        "write_file",
        "search_text",
      ]);

      expect(calls).toHaveLength(1);
      const args = calls[0]!.args;
      expect(args.slice(0, 3)).toEqual(["-a", "never", "exec"]);
      expect(args).toContain("--ephemeral");
      expect(args[args.indexOf("--sandbox") + 1]).toBe("workspace-write");
    } finally {
      await fs.rm(runtimeDir, { recursive: true, force: true });
    }
  });
});
