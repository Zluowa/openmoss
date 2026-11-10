import * as fs from "node:fs/promises";
import path from "node:path";
import { redactDiagnosticText } from "@moss/shared/diagnosticsRedaction";
import type { RepairCommand, RepairReport } from "./devsRepairRunner";

export interface LocalCodexConfig {
  executable: string;
  model: string;
  /** Optional Claude model served by Magpie using the same local Codex harness. */
  claudeModel?: string;
  /** Local Magpie origin, not an upstream provider URL or credential. */
  magpieUrl: string;
}

/** Keep controller credentials and Desktop/session routing out of local tools. */
export function localRepairEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed =
    /^(?:PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|USERNAME|USERDOMAIN|COMPUTERNAME|ALLUSERSPROFILE|OS|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES(?:\(X86\))?|HOMEDRIVE|HOMEPATH|HOME|LANG|LC_ALL|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|NPM_CONFIG_CACHE|BUN_INSTALL_CACHE_DIR)$/i;
  const environment = Object.fromEntries(
    Object.entries(source).filter(([name]) => allowed.test(name)),
  );
  for (const [name, value] of Object.entries(source)) {
    if (/^NO_PROXY$/i.test(name)) environment[name] = value;
    if (!/^(?:HTTP|HTTPS|ALL)_PROXY$/i.test(name) || !value) continue;
    try {
      const url = new URL(value);
      if (
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
        !url.username &&
        !url.password
      )
        environment[name] = value;
    } catch {
      /* An invalid or authenticated proxy is not inherited by agent tools. */
    }
  }
  return environment;
}

export function validateLocalCodexConfig(config: LocalCodexConfig): URL {
  const url = new URL(config.magpieUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Local repairs require a loopback Magpie origin.");
  if (!config.executable.trim() || !config.model.trim())
    throw new Error("Local repairs require a Codex executable and Magpie model ID.");
  return url;
}

/** Uses a dedicated config; never reads or rewrites the owner's Codex auth or sessions. */
export async function runLocalCodex(
  config: LocalCodexConfig,
  report: RepairReport,
  options: {
    cwd: string;
    runtimeDir: string;
    prompt: string;
    timeoutMs: number;
    /** Screenshots from the report, attached to the prompt as images. */
    images?: readonly string[];
  },
  run: RepairCommand,
): Promise<void> {
  if (report.engine !== "codex" && !config.claudeModel)
    throw new Error("The local Claude model route is not configured.");
  const url = validateLocalCodexConfig(config);
  const home = path.join(options.runtimeDir, report.id);
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(home, "config.toml"),
    [
      'model_provider = "magpie"',
      `model = ${JSON.stringify(report.engine === "claude" ? config.claudeModel : config.model)}`,
      'model_reasoning_effort = "high"',
      'web_search = "disabled"',
      "allow_login_shell = false",
      `developer_instructions = ${JSON.stringify('This public repair job has no shell. Use the moss_workspace list_files, read_file, search_text and write_file tools to inspect and edit only this checkout; when they are offered through the exec tool, call them from its JavaScript, for example await tools.mcp__moss_workspace__read_file({ path: "README.md" }). Do not execute commands or seek other host access. Do not change Git or Git LFS configuration (any .git* file or .lfsconfig), dependencies, workflows or verification configuration: the controller rejects the whole job if you do. The trusted controller runs the canonical checks in ephemeral CI after your edits; record that local execution was unavailable and never invent test results. Do not commit or publish.')}`,
      "[model_providers.magpie]",
      'name = "Magpie"',
      `base_url = ${JSON.stringify(new URL("v1", url).href)}`,
      'wire_api = "responses"',
      'env_key = "MOSS_DEVS_MAGPIE_KEY"',
      // Every tool that could run a command, open a browser or reach another service is off.
      // The controller does not rely on this: it re-checks everything the job changed.
      "[features]",
      "shell_tool = false",
      "unified_exec = false",
      // Codex 0.166 offers every tool to current models only through code mode's exec tool,
      // including moss_workspace. Its host is a V8 isolate with no require, process, fetch or
      // file access: it can call only the tools listed here. With the host off the agent can
      // neither read nor edit the checkout, which is why job 0eafa169 produced nothing.
      "code_mode_host = true",
      "view_image = false",
      "image_generation = false",
      "browser_use = false",
      "browser_use_external = false",
      "in_app_browser = false",
      "computer_use = false",
      "hooks = false",
      "apps = false",
      "plugins = false",
      "remote_plugin = false",
      "tool_suggest = false",
      "skill_mcp_dependency_install = false",
      "workspace_dependencies = false",
      "multi_agent = false",
      "memories = false",
      "skip_host_skill_discovery = true",
      // Codex's own patch tool may write only inside the checkout, never the temp folders.
      "[sandbox_workspace_write]",
      "network_access = false",
      "exclude_tmpdir_env_var = true",
      "exclude_slash_tmp = true",
      "[mcp_servers.moss_workspace]",
      'enabled_tools = ["list_files", "read_file", "write_file", "search_text"]',
      'default_tools_approval_mode = "approve"',
      `command = ${JSON.stringify(process.execPath)}`,
      `args = ${JSON.stringify([path.join(import.meta.dirname, "devsWorkspaceMcp.ts"), options.cwd])}`,
      "startup_timeout_sec = 30",
      "tool_timeout_sec = 30",
      "[windows]",
      'sandbox = "unelevated"',
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const output = await run(
    config.executable,
    [
      "-a",
      "never",
      "exec",
      "--ephemeral",
      "--sandbox",
      "workspace-write",
      "-C",
      options.cwd,
      // `=` keeps the prompt's `-` from being read as another image.
      ...(options.images ?? []).map((image) => `--image=${image}`),
      "-",
    ],
    {
      cwd: options.cwd,
      env: {
        ...localRepairEnvironment(),
        CODEX_HOME: home,
        // Magpie documents this as a public localhost caller label, not a vendor key.
        MOSS_DEVS_MAGPIE_KEY: "magpie-moss-devs",
      },
      input: options.prompt,
      timeoutMs: options.timeoutMs,
    },
  );
  // Ephemeral runs keep no session: this is the only record of what the agent did and said.
  await fs.writeFile(
    path.join(home, "codex-output.log"),
    redactDiagnosticText(output, { maxLength: 200_000 }),
    { mode: 0o600 },
  );
}
