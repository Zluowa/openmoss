import type { GitHubConnectionInput, GitHubConnectionResult } from "@moss/contracts";
import { runProcess, type ProcessRunOptions } from "../processRunner";
import {
  appendManagedToolBinDirectoryToPath,
  createSystemToolInstallHost,
  mossToolsDirectory,
  runSystemToolInstall,
  SYSTEM_TOOL_INSTALLS,
  type SystemToolInstallOutcome,
  type SystemToolInstallPhase,
} from "../systemTools/systemToolInstall";

/**
 * Installs GitHub CLI on this computer: on Windows the official zip into Moss's own folder, on
 * macOS Homebrew, then the official package.
 */
export type InstallGitHubCli = (options: {
  onProgress: (phase: SystemToolInstallPhase, percent?: number) => void;
  signal: AbortSignal;
}) => Promise<SystemToolInstallOutcome>;

/**
 * The installer for a server whose Moss home is `mossHomeDir`. It also puts the folder Moss
 * unpacks GitHub CLI into on this server's PATH, after the person's own entries, so a copy
 * installed earlier is found again after a restart.
 */
export function mossGitHubCliInstaller(mossHomeDir: string): InstallGitHubCli {
  const tool = SYSTEM_TOOL_INSTALLS["github-cli"];
  const toolsDirectory = mossToolsDirectory(mossHomeDir);
  appendManagedToolBinDirectoryToPath(tool, toolsDirectory);
  return ({ onProgress, signal }) =>
    runSystemToolInstall({
      tool,
      host: createSystemToolInstallHost(process.env, { toolsDirectory }),
      onProgress,
      signal,
    });
}

/** Without a Moss home there is nowhere to unpack into; macOS still installs. */
const installGitHubCli: InstallGitHubCli = ({ onProgress, signal }) =>
  runSystemToolInstall({
    tool: SYSTEM_TOOL_INSTALLS["github-cli"],
    host: createSystemToolInstallHost(),
    onProgress,
    signal,
  });

const COMMAND_TIMEOUT = 10_000;
const DEVICE_TIMEOUT = 15 * 60_000;
const host = "github.com";
type Execute = (
  args: readonly string[],
  options: ProcessRunOptions,
) => ReturnType<typeof runProcess>;

/** gh owns its credentials. Keep other provider credentials, debug, TTY and host overrides out of this child. */
function executeGh(args: readonly string[], options: ProcessRunOptions) {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      /^(?:PATH|PATHEXT|COMSPEC|SYSTEMROOT|WINDIR|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES(?:\(X86\))?|TMP|TEMP|XDG_CONFIG_HOME|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|SSH_AUTH_SOCK|GH_CONFIG_DIR|GH_TOKEN|GITHUB_TOKEN|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR)$/i.test(
        key,
      )
    )
      env[key] = value;
  }
  return runProcess("gh", args, {
    ...options,
    env: {
      ...env,
      GH_HOST: host,
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
      NO_COLOR: "1",
    },
    timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT,
    allowNonZeroExit: true,
    maxBufferBytes: 16_384,
    outputMode: "truncate",
  });
}

type Attempt = {
  owner: string;
  id: string;
  controller: AbortController;
  result: GitHubConnectionResult;
  done: Promise<void>;
};

/** Only the requesting owner session and its unguessable ticket may observe a device code.
 * The command returns through pipes, so gh prints its code without opening another host's browser. */
export function createGitHubConnection(
  execute: Execute = executeGh,
  onIdentityChange: () => Promise<void> = async () => {},
  installGh: InstallGitHubCli = installGitHubCli,
) {
  let observed: string | null | undefined;
  let attempt: Attempt | undefined;
  let running = false;
  let checking: Promise<GitHubConnectionResult> | undefined;
  /** The one GitHub CLI install on this computer; a failure is reported once, then cleared. */
  let install:
    | {
        result: GitHubConnectionResult;
        finished: boolean;
        controller: AbortController;
        done: Promise<void>;
      }
    | undefined;

  function startInstall(): GitHubConnectionResult {
    const controller = new AbortController();
    const job: NonNullable<typeof install> = {
      result: { state: "installing", phase: "installing" },
      finished: false,
      controller,
      done: Promise.resolve(),
    };
    install = job;
    job.done = (async () => {
      try {
        const before = await status();
        if (before.state !== "missing" || controller.signal.aborted) {
          if (install === job) install = undefined;
          return;
        }
        const outcome = await installGh({
          signal: controller.signal,
          onProgress: (phase, percent) => {
            if (install === job && !job.finished)
              job.result =
                percent === undefined
                  ? { state: "installing", phase }
                  : { state: "installing", phase, percent };
          },
        });
        if (install !== job) return;
        if (outcome.ok) {
          install = undefined;
          return;
        }
        console.warn(`GitHub CLI install failed (${outcome.reason}): ${outcome.detail}`);
        job.result = { state: "installFailed", reason: outcome.reason };
        job.finished = true;
      } catch {
        if (install === job) {
          job.result = { state: "installFailed", reason: "install-failed" };
          job.finished = true;
        }
      }
    })();
    return job.result;
  }

  /** While an install runs, a status check reports its progress instead of probing. */
  function installState(): GitHubConnectionResult | undefined {
    if (!install) return undefined;
    if (install.finished) {
      const failure = install.result;
      install = undefined;
      return failure;
    }
    return install.result;
  }

  async function probe(signal?: AbortSignal): Promise<GitHubConnectionResult> {
    try {
      const auth = await execute(["api", "user", "--hostname", host, "--jq", ".login"], { signal });
      const login = auth.stdout.trim();
      if (!auth.timedOut && auth.code === 0 && /^[a-z\d](?:[a-z\d-]{0,38})$/i.test(login))
        return { state: "connected", login };
      if (
        !auth.timedOut &&
        /(?:gh auth login|not logged in|HTTP 401|Bad credentials)/i.test(auth.stderr)
      )
        return { state: "disconnected" };
    } catch (error) {
      if (error instanceof Error && error.message === "Command not found: gh")
        return { state: "missing" };
    }
    return { state: "unavailable" };
  }

  function status(): Promise<GitHubConnectionResult> {
    checking ??= probe()
      .then(async (state) => {
        if (
          state.state === "connected" ||
          state.state === "disconnected" ||
          state.state === "missing"
        ) {
          const login = state.state === "connected" ? state.login.toLowerCase() : null;
          if (login !== observed) {
            await onIdentityChange();
            observed = login;
          }
        }
        return state;
      })
      .finally(() => {
        checking = undefined;
      });
    return checking;
  }

  async function signIn(job: Attempt): Promise<void> {
    const signal = job.controller.signal;
    const publish = (result: GitHubConnectionResult) => {
      if (job === attempt && !signal.aborted) job.result = result;
    };
    try {
      const before = await status();
      if (signal.aborted) return;
      if (before.state !== "disconnected") {
        publish(before);
        return;
      }
      const help = await execute(["auth", "login", "--help"], { signal });
      if (help.code !== 0 || help.timedOut) {
        publish({ state: "unavailable" });
        return;
      }
      const args = ["auth", "login", "--hostname", host, "--web"];
      // Older gh did not copy by default. Newer gh has an explicit negative flag.
      if (help.stdout.includes("--clipboard")) args.push("--clipboard=false");
      let tail = "";
      const auth = await execute(args, {
        signal,
        timeoutMs: DEVICE_TIMEOUT,
        onStderrChunk(chunk) {
          if (signal.aborted || job.result.state !== "pending" || job.result.code !== null) return;
          tail = (tail + chunk.slice(-2048)).slice(-2048);
          const code = /First copy your one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})(?=\s|$)/.exec(
            tail,
          )?.[1];
          if (code) {
            publish({ state: "pending", code });
            tail = "";
          }
        },
      });
      if (signal.aborted) return;
      if (auth.code !== 0 || auth.timedOut) {
        publish({ state: "failed" });
        return;
      }
      if (checking) await checking;
      const after = await status();
      publish(after.state === "connected" ? after : { state: "failed" });
    } catch {
      publish({ state: "failed" });
    } finally {
      running = false;
    }
  }

  return {
    async handle(owner: string, input: GitHubConnectionInput): Promise<GitHubConnectionResult> {
      if (!("requestId" in input)) {
        // A query never reveals another window's pending code.
        if (input.op === "status") return installState() ?? status();
        if (install && !install.finished) return install.result;
        if (running) return { state: "busy" };
        return startInstall();
      }
      if (attempt?.id === input.requestId && attempt.owner === owner) {
        if (input.op === "cancel" && running) {
          attempt.result = { state: "cancelled" };
          attempt.controller.abort();
        }
        return attempt.result;
      }
      if (input.op !== "start") return { state: "expired" };
      if (running || (install && !install.finished)) return { state: "busy" };
      const job: Attempt = {
        owner,
        id: input.requestId,
        controller: new AbortController(),
        result: { state: "pending", code: null },
        done: Promise.resolve(),
      };
      attempt = job;
      running = true;
      job.done = signIn(job);
      return job.result;
    },
    async close() {
      attempt?.controller.abort();
      install?.controller.abort();
      await Promise.all([attempt?.done, install?.done]);
    },
  };
}
