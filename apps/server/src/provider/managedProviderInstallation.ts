// FILE: managedProviderInstallation.ts
// Purpose: Inspects agent locations and removes only identified Moss-managed installs.
// Layer: Provider installation lifecycle (asynchronous filesystem only)
// Exports: inspectProviderInstallation, removeManagedProviderInstallation

import { randomUUID } from "node:crypto";
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import {
  PROVIDER_INSTALLATION_ERROR_CODES,
  type ProviderInstallationErrorCode,
  type ProviderKind,
  type ProviderSession,
  type ServerProviderInstallationResult,
} from "@moss/contracts";
import { npmGlobalLauncherSuffixes } from "../platform/npmGlobalLayout.ts";
import { managedAgentBinDirectory } from "./managedAgentPaths.ts";
import { ONE_CLICK_AGENT_INSTALLS, managedAgentInstallPrefix } from "./providerInstall.ts";
import { LAUNCHER_CMD, LAUNCHER_PS1 } from "./cursorWindowsInstall.ts";

interface InstallationInput {
  readonly provider: ProviderKind;
  readonly mossHomeDir: string;
  readonly binaryPath: string | null;
  readonly bundled: boolean;
}

/** A refusal the person can act on; `code` reaches the settings UI unchanged. */
export class ProviderInstallationError extends Error {
  constructor(
    readonly code: ProviderInstallationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProviderInstallationError";
  }
}

const IN_USE_ERRNO = new Set(["EBUSY", "EPERM", "EACCES"]);

export function assertProviderInstallationRemovalAllowed(
  provider: ProviderKind,
  state: {
    readonly instances?: ReadonlyArray<{ readonly driver: string; readonly enabled: boolean }>;
    readonly sessions?: ReadonlyArray<Pick<ProviderSession, "provider" | "status">>;
  },
): void {
  if (state.instances?.some((entry) => entry.driver === provider && entry.enabled))
    throw new ProviderInstallationError(
      PROVIDER_INSTALLATION_ERROR_CODES.agentEnabled,
      "Turn this agent off before removing its Moss-managed installation.",
    );
  if (state.sessions?.some((entry) => entry.provider === provider && entry.status !== "closed"))
    throw new ProviderInstallationError(
      PROVIDER_INSTALLATION_ERROR_CODES.sessionsRunning,
      "Finish this agent's running sessions before uninstalling it.",
    );
}

async function ordinaryDirectory(path: string): Promise<boolean> {
  try {
    const entry = await FS.lstat(path);
    return entry.isDirectory() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}

function inside(root: string, child: string): boolean {
  const relative = Path.relative(root, child);
  return (
    relative.length > 0 &&
    !relative.startsWith(`..${Path.sep}`) &&
    relative !== ".." &&
    !Path.isAbsolute(relative)
  );
}

async function managedRoot(input: InstallationInput): Promise<string | null> {
  const prefix = managedAgentInstallPrefix(input.mossHomeDir);
  if (!(await ordinaryDirectory(prefix))) return null;
  const install = ONE_CLICK_AGENT_INSTALLS[input.provider];
  const root =
    input.provider === "cursor"
      ? Path.join(prefix, "cursor")
      : install
        ? Path.join(prefix, "node_modules", ...install.packageName.split("/"))
        : null;
  if (!root || !(await ordinaryDirectory(root))) return null;
  const [realPrefix, realRoot] = await Promise.all([FS.realpath(prefix), FS.realpath(root)]);
  if (!inside(realPrefix, realRoot)) return null;
  if (input.provider !== "cursor") {
    const manifestPath = Path.join(root, "package.json");
    const manifestInfo = await FS.lstat(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 65_536)
      return null;
    const manifest = JSON.parse(await FS.readFile(manifestPath, "utf8")) as { name?: unknown };
    if (manifest.name !== install?.packageName) return null;
  }
  return root;
}

export async function inspectProviderInstallation(
  input: InstallationInput,
): Promise<ServerProviderInstallationResult> {
  const root = await managedRoot(input);
  const prefix = managedAgentInstallPrefix(input.mossHomeDir);
  const binaryIsManaged = Boolean(
    input.binaryPath && inside(prefix, Path.resolve(input.binaryPath)),
  );
  return {
    provider: input.provider,
    source: input.bundled
      ? "bundled"
      : input.binaryPath
        ? binaryIsManaged
          ? "moss"
          : "external"
        : "missing",
    path: input.binaryPath,
    managedPath: root,
    canUninstall: root !== null,
    removed: false,
  };
}

/** Returns whether the selected program was moved; callers may then invalidate its facts. */
export async function removeManagedProviderInstallation(
  input: InstallationInput,
  options: { readonly rename?: typeof FS.rename } = {},
): Promise<boolean> {
  const rename = options.rename ?? FS.rename;
  const prefix = managedAgentInstallPrefix(input.mossHomeDir);
  const root = await managedRoot(input);
  if (!root)
    throw new ProviderInstallationError(
      PROVIDER_INSTALLATION_ERROR_CODES.notFound,
      "No removable Moss-managed agent installation was found.",
    );
  const realPrefix = await FS.realpath(prefix);
  const install = ONE_CLICK_AGENT_INSTALLS[input.provider];
  const files: string[] = [];
  if (input.provider === "cursor") {
    const shim = Path.join(prefix, "cursor-agent.cmd");
    const script = Path.join(root, "resolve-version.ps1");
    if (
      (await FS.readFile(shim, "utf8")) !== LAUNCHER_CMD ||
      (await FS.readFile(script, "utf8")) !== LAUNCHER_PS1
    )
      throw new ProviderInstallationError(
        PROVIDER_INSTALLATION_ERROR_CODES.modified,
        "The Cursor launcher was changed outside Moss.",
      );
    files.push(shim);
  } else {
    if (!install)
      throw new ProviderInstallationError(
        PROVIDER_INSTALLATION_ERROR_CODES.notFound,
        "This agent is not managed by Moss.",
      );
    const manifest = JSON.parse(await FS.readFile(Path.join(root, "package.json"), "utf8")) as {
      bin?: unknown;
    };
    const names =
      typeof manifest.bin === "object" && manifest.bin !== null && !Array.isArray(manifest.bin)
        ? Object.keys(manifest.bin)
        : [install.command];
    const binDirectory = managedAgentBinDirectory(prefix);
    for (const name of new Set([...names, install.command])) {
      if (!/^[a-z0-9_-]{1,64}$/iu.test(name))
        throw new ProviderInstallationError(
          PROVIDER_INSTALLATION_ERROR_CODES.modified,
          "Invalid installed agent launcher.",
        );
      for (const suffix of npmGlobalLauncherSuffixes()) {
        const shim = Path.join(binDirectory, `${name}${suffix}`);
        const info = await FS.lstat(shim).catch(() => null);
        if (!info) continue;
        if (info.isSymbolicLink()) {
          if (!inside(await FS.realpath(root), await FS.realpath(shim)))
            throw new ProviderInstallationError(
              PROVIDER_INSTALLATION_ERROR_CODES.modified,
              "Agent launcher points outside its package.",
            );
        } else {
          if (!info.isFile() || info.size > 65_536)
            throw new ProviderInstallationError(
              PROVIDER_INSTALLATION_ERROR_CODES.modified,
              "Agent launcher is not an ordinary file.",
            );
          const text = (await FS.readFile(shim, "utf8")).replaceAll("\\", "/");
          if (!text.includes(`node_modules/${install.packageName}/`))
            throw new ProviderInstallationError(
              PROVIDER_INSTALLATION_ERROR_CODES.modified,
              "Agent launcher was changed outside Moss.",
            );
        }
        files.push(shim);
      }
    }
  }
  files.push(root);
  const selectedPath = input.binaryPath ? Path.resolve(input.binaryPath) : null;
  const selectedRealPath = input.binaryPath
    ? await FS.realpath(input.binaryPath).catch(() => null)
    : null;
  const selectedProgramMoved = Boolean(
    selectedPath &&
    (files.some((file) => Path.relative(file, selectedPath) === "") ||
      inside(root, selectedPath) ||
      (selectedRealPath && inside(await FS.realpath(root), selectedRealPath))),
  );
  // Preserve a recoverable copy. No user installation, account, conversation, or
  // unrelated shared dependency is deleted; removed commands immediately leave PATH.
  const removedRoot = Path.join(prefix, ".removed");
  await FS.mkdir(removedRoot).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code !== "EEXIST") throw cause;
  });
  if (
    !(await ordinaryDirectory(removedRoot)) ||
    !inside(realPrefix, await FS.realpath(removedRoot))
  )
    throw new ProviderInstallationError(
      PROVIDER_INSTALLATION_ERROR_CODES.modified,
      "The removal backup folder is not owned by Moss.",
    );
  const backup = await FS.mkdtemp(Path.join(removedRoot, `${input.provider}-`));
  const moved: Array<{ from: string; to: string }> = [];
  try {
    for (const from of files) {
      const parent = await FS.realpath(Path.dirname(from));
      if (parent !== realPrefix && !inside(realPrefix, parent))
        throw new ProviderInstallationError(
          PROVIDER_INSTALLATION_ERROR_CODES.modified,
          "Agent path left the managed folder.",
        );
      const to = Path.join(backup, `${randomUUID()}-${Path.basename(from)}`);
      await rename(from, to);
      moved.push({ from, to });
    }
  } catch (cause) {
    for (const entry of moved.toReversed()) await FS.rename(entry.to, entry.from);
    // Windows refuses to move a program file that a running agent still holds open.
    if (IN_USE_ERRNO.has((cause as NodeJS.ErrnoException).code ?? ""))
      throw new ProviderInstallationError(
        PROVIDER_INSTALLATION_ERROR_CODES.inUse,
        "This agent's files are still in use. Close the agent and try again.",
      );
    throw cause;
  }
  return selectedProgramMoved;
}
