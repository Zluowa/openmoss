// FILE: agentVersionStore.test.ts
// Purpose: In-app Codex/Claude updates install beside the running copy, switch new launches
//          atomically, and only remove copies nothing uses.
// Layer: Provider maintenance tests (temp folders only).

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import * as FS from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { makeAgentProgramOwnership } from "./agentProgramOwnership.ts";
import {
  AGENT_UPDATED_PATH_ENV_KEYS,
  agentVersionsRoot,
  installAgentVersionSideBySide,
  pruneAgentVersions,
  readActiveAgentVersion,
  restoreActiveAgentVersions,
} from "./agentVersionStore.ts";
import type { AgentInstallOutcome } from "./providerInstall.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function mossHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "moss-agent-versions-"));
  homes.push(home);
  return home;
}

function fakeInstall(version: string) {
  return (prefix: string) =>
    Effect.promise(async (): Promise<AgentInstallOutcome> => {
      const executable = path.join(prefix, "codex.cmd");
      await FS.writeFile(executable, `codex ${version}`);
      return {
        ok: true,
        version,
        source: "official",
        binDirectory: prefix,
        executable,
      };
    });
}

describe.each(["codex", "claudeAgent"] as const)("%s side-by-side updates", (agent) => {
  it("installs beside a copy that is still running and switches new launches to it", async () => {
    const home = mossHome();
    const env: NodeJS.ProcessEnv = {};
    const programs = makeAgentProgramOwnership(agent);
    const switches: number[] = [];
    programs.onProgramSwitched(() => switches.push(1));

    const first = await Effect.runPromise(
      installAgentVersionSideBySide({
        mossHomeDir: home,
        agent,
        targetVersion: "0.170.0",
        programs,
        install: fakeInstall("0.170.0"),
        env,
      }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // The first copy runs and its exit is never confirmed.
    const running = programs.spawn({
      binaryPath: first.executable,
      sourceHomePath: path.join(home, "state"),
      spawn: () => new EventEmitter(),
    });

    const second = await Effect.runPromise(
      installAgentVersionSideBySide({
        mossHomeDir: home,
        agent,
        targetVersion: "0.171.0",
        programs,
        install: fakeInstall("0.171.0"),
        env,
      }),
    );

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(env[AGENT_UPDATED_PATH_ENV_KEYS[agent]]).toBe(second.executable);
    expect(switches).toHaveLength(2);
    // The running copy is untouched: same file, same content.
    expect(await FS.readFile(first.executable, "utf8")).toBe("codex 0.170.0");
    expect(path.dirname(second.executable)).not.toBe(path.dirname(first.executable));
    expect((await readActiveAgentVersion(home, agent))?.executable).toBe(second.executable);
    // The same state home may start the new copy right away.
    programs
      .beginOperation({ binaryPath: second.executable, sourceHomePath: path.join(home, "state") })
      .failedToSpawn();

    // Once nothing runs from the old copy, the next pass removes it.
    running.emit("close");
    const removed = await pruneAgentVersions({
      mossHomeDir: home,
      agent,
      isInUse: (directory) => programs.isDirectoryInUse(directory),
    });
    expect(removed).toEqual([path.dirname(first.executable)]);
    const left = await FS.readdir(agentVersionsRoot(home, agent));
    expect(left.toSorted()).toEqual(
      ["active.json", path.basename(path.dirname(second.executable))].toSorted(),
    );
  });

  it("keeps the current copy and leaves no folder behind when the download fails", async () => {
    const home = mossHome();
    const env: NodeJS.ProcessEnv = {};
    const programs = makeAgentProgramOwnership(agent);
    let switched = false;
    programs.onProgramSwitched(() => {
      switched = true;
    });

    const outcome = await Effect.runPromise(
      installAgentVersionSideBySide({
        mossHomeDir: home,
        agent,
        targetVersion: "0.171.0",
        programs,
        install: () =>
          Effect.succeed({
            ok: false,
            reason: "download-failed",
            detail: "npm on https://registry.npmmirror.com: npm error code ENOSPC",
          } satisfies AgentInstallOutcome),
        env,
      }),
    );

    expect(outcome).toMatchObject({ ok: false, reason: "download-failed" });
    expect(switched).toBe(false);
    expect(env[AGENT_UPDATED_PATH_ENV_KEYS[agent]]).toBeUndefined();
    expect(await FS.readdir(agentVersionsRoot(home, agent))).toEqual([]);
  });

  it("restores only a pointer that names a copy inside the store", async () => {
    const home = mossHome();
    const env: NodeJS.ProcessEnv = {};
    const programs = makeAgentProgramOwnership(agent);
    const installed = await Effect.runPromise(
      installAgentVersionSideBySide({
        mossHomeDir: home,
        agent,
        targetVersion: "1.0.0",
        programs,
        install: fakeInstall("1.0.0"),
        env: {},
      }),
    );
    expect(installed.ok).toBe(true);
    await restoreActiveAgentVersions(home, env);
    expect(env[AGENT_UPDATED_PATH_ENV_KEYS[agent]]).toBe(installed.ok && installed.executable);

    const pointer = path.join(agentVersionsRoot(home, agent), "active.json");
    await FS.writeFile(
      pointer,
      JSON.stringify({ version: "1.0.0", directory: "..", executable: "elsewhere.cmd" }),
    );
    await restoreActiveAgentVersions(home, env);
    expect(env[AGENT_UPDATED_PATH_ENV_KEYS[agent]]).toBeUndefined();
  });
});
