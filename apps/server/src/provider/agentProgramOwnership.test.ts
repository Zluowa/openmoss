// FILE: agentProgramOwnership.test.ts
// Purpose: Keeps a native source on one program until all owned processes really close.
// Layer: Provider process ownership tests

import { EventEmitter } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Fiber } from "effect";
import {
  agentProgramsForServer,
  agentProgramSourceHome,
  makeAgentProgramOwnership,
} from "./agentProgramOwnership.ts";
import { buildClaudeInstanceProcessEnv } from "./claudeEnvironment.ts";

describe.each(["codex", "claudeAgent"] as const)("%s program ownership", (provider) => {
  const directories: string[] = [];
  function fixture() {
    const directory = mkdtempSync(path.join(os.tmpdir(), "moss-program-owner-"));
    directories.push(directory);
    const first = path.join(directory, "first-cli");
    const second = path.join(directory, "second-cli");
    writeFileSync(first, "old program");
    writeFileSync(second, "new program");
    return { first, second, sourceHomePath: path.join(directory, "state") };
  }
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  it("retains all concurrent owners through cancellation, exit and delayed close", () => {
    const { first, second, sourceHomePath } = fixture();
    const ownership = makeAgentProgramOwnership(provider);
    const start = (binaryPath: string) =>
      ownership.spawn({ binaryPath, sourceHomePath, spawn: () => new EventEmitter() });
    const a = start(first);
    const b = start(first);
    // Session-map deletion, abort/timeout and exit do not prove stdio/tree close.
    a.emit("abort");
    a.emit("exit");
    const rejectedSpawn = vi.fn(() => new EventEmitter());
    expect(() =>
      ownership.spawn({ binaryPath: second, sourceHomePath, spawn: rejectedSpawn }),
    ).toThrow(/Restart Moss/);
    expect(rejectedSpawn).not.toHaveBeenCalled();
    a.emit("close");
    a.emit("close");
    expect(() => start(second)).toThrow(/Restart Moss/);
    expect(() => ownership.beginMaintenance(first)).toThrow(/still in use/);
    b.emit("close");
    expect(() => start(second)).toThrow(/Restart Moss/);
    const c = start(first);
    // Repeated cleanup of the old process must not free the new owner's record.
    a.emit("close");
    expect(() => ownership.beginMaintenance(first)).toThrow(/still in use/);
    c.emit("close");
    expect(() => start(first)).not.toThrow();
  });

  it("releases only a synchronously failed spawn and preserves other owners", () => {
    const { first, second, sourceHomePath } = fixture();
    const ownership = makeAgentProgramOwnership(provider);
    const fail = () =>
      ownership.spawn({
        binaryPath: first,
        sourceHomePath,
        spawn: () => {
          throw new Error("spawn failed");
        },
      });
    expect(fail).toThrow("spawn failed");
    const owner = ownership.spawn({
      binaryPath: second,
      sourceHomePath,
      spawn: () => new EventEmitter(),
    });
    expect(fail).toThrow(/Restart Moss/);
    owner.emit("close");
    const existing = ownership.spawn({
      binaryPath: second,
      sourceHomePath,
      spawn: () => new EventEmitter(),
    });
    expect(fail).toThrow(/Restart Moss/);
    expect(() => ownership.beginMaintenance(second)).toThrow(/still in use/);
    existing.emit("close");
    expect(() =>
      ownership.spawn({ binaryPath: second, sourceHomePath, spawn: () => new EventEmitter() }),
    ).not.toThrow();
  });

  it("blocks replacement in place but permits independent native sources", () => {
    const { first, second, sourceHomePath } = fixture();
    const ownership = makeAgentProgramOwnership(provider);
    const owner = ownership.spawn({
      binaryPath: first,
      sourceHomePath,
      spawn: () => new EventEmitter(),
    });
    writeFileSync(first, "replacement program with different size");
    expect(() =>
      ownership.spawn({ binaryPath: first, sourceHomePath, spawn: () => new EventEmitter() }),
    ).toThrow(/Restart Moss/);
    expect(() =>
      ownership.spawn({
        binaryPath: second,
        sourceHomePath: `${sourceHomePath}-other`,
        spawn: () => new EventEmitter(),
      }),
    ).not.toThrow();
    owner.emit("close");
    expect(() =>
      ownership.spawn({ binaryPath: first, sourceHomePath, spawn: () => new EventEmitter() }),
    ).toThrow(/Restart Moss/);
  });

  it("recognizes a second spelling of the same native source", () => {
    const { first, second, sourceHomePath } = fixture();
    mkdirSync(sourceHomePath);
    const alias = `${sourceHomePath}-alias`;
    symlinkSync(sourceHomePath, alias, process.platform === "win32" ? "junction" : "dir");
    const ownership = makeAgentProgramOwnership(provider);
    const owner = ownership.spawn({
      binaryPath: first,
      sourceHomePath,
      spawn: () => new EventEmitter(),
    });
    expect(() =>
      ownership.spawn({
        binaryPath: second,
        sourceHomePath: alias,
        spawn: () => new EventEmitter(),
      }),
    ).toThrow(/Restart Moss/);
    owner.emit("close");
    expect(() =>
      ownership.spawn({
        binaryPath: second,
        sourceHomePath: alias,
        spawn: () => new EventEmitter(),
      }),
    ).toThrow(/Restart Moss/);
  });

  it("shares one server epoch across entry points, but not other providers or servers", () => {
    const { first, second, sourceHomePath } = fixture();
    const scope = {};
    const chat = agentProgramsForServer(scope, provider);
    const health = agentProgramsForServer(scope, provider);
    expect(health).toBe(chat);
    chat
      .spawn({ binaryPath: first, sourceHomePath, spawn: () => new EventEmitter() })
      .emit("close");
    expect(() => health.beginOperation({ binaryPath: second, sourceHomePath })).toThrow(
      /Restart Moss/,
    );
    expect(() =>
      agentProgramsForServer({}, provider).beginOperation({ binaryPath: second, sourceHomePath }),
    ).not.toThrow();
    expect(() =>
      agentProgramsForServer(scope, provider === "codex" ? "claudeAgent" : "codex").beginOperation({
        binaryPath: second,
        sourceHomePath,
      }),
    ).not.toThrow();
  });

  it("permits update after a completed probe and excludes new spawns across account sources", async () => {
    const { first, second, sourceHomePath } = fixture();
    const programs = makeAgentProgramOwnership(provider);
    await Effect.runPromise(
      programs.withOperation({ binaryPath: first, sourceHomePath }, (spawned) =>
        Effect.sync(spawned),
      ),
    );
    const other = programs.spawn({
      binaryPath: first,
      sourceHomePath: `${sourceHomePath}-account`,
      spawn: () => new EventEmitter(),
    });
    expect(() => programs.beginMaintenance(first)).toThrow(/still in use/);
    other.emit("exit");
    expect(() => programs.beginMaintenance(first)).toThrow(/still in use/);
    other.emit("close");
    const update = programs.beginMaintenance(first);
    expect(() =>
      programs.beginOperation({ binaryPath: first, sourceHomePath: `${sourceHomePath}-new` }),
    ).toThrow(/still in use/);
    expect(() =>
      programs.beginOperation({
        binaryPath: second,
        sourceHomePath: `${sourceHomePath}-independent`,
      }),
    ).not.toThrow();
    update.finish(true);
    update.finish(false);
    expect(() =>
      programs.beginOperation({ binaryPath: first, sourceHomePath: `${sourceHomePath}-new` }),
    ).toThrow(/Restart Moss/);
  });

  it("releases a definite spawn failure and retains an interrupted operation until restart", async () => {
    const { first, second, sourceHomePath } = fixture();
    const programs = makeAgentProgramOwnership(provider);
    await expect(
      Effect.runPromise(
        programs.withOperation({ binaryPath: first, sourceHomePath }, () =>
          Effect.fail(new Error("spawn failed")),
        ),
      ),
    ).rejects.toThrow("spawn failed");
    const fiber = Effect.runFork(
      programs.withOperation({ binaryPath: second, sourceHomePath }, (spawned) =>
        Effect.sync(spawned).pipe(Effect.andThen(Effect.never)),
      ),
    );
    await Effect.runPromise(Effect.yieldNow);
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(() => programs.beginMaintenance(second)).toThrow(/still in use/);
  });

  it("never lets missing stat identity or a runnable bare command bypass checks", () => {
    const { first, sourceHomePath } = fixture();
    const programs = makeAgentProgramOwnership(provider);
    const missing = `${first}-missing`;
    programs
      .spawn({ binaryPath: missing, sourceHomePath, spawn: () => new EventEmitter() })
      .emit("close");
    expect(() => programs.beginOperation({ binaryPath: first, sourceHomePath })).toThrow(
      /Restart Moss/,
    );
    const command = path.join(
      path.dirname(first),
      process.platform === "win32" ? "custom.cmd" : "custom",
    );
    writeFileSync(command, "echo fixture");
    chmodSync(command, 0o755);
    expect(() =>
      programs.beginOperation({
        binaryPath: "custom",
        sourceHomePath,
        env: { PATH: path.dirname(first), PATHEXT: ".CMD" },
      }),
    ).toThrow(/absolute agent program path/);
    const temporary = `${sourceHomePath}-temporary`;
    const env =
      provider === "codex"
        ? { CODEX_HOME: sourceHomePath, CODEX_SQLITE_HOME: temporary }
        : { HOME: sourceHomePath, CLAUDE_CONFIG_DIR: temporary };
    expect(agentProgramSourceHome(provider, env, sourceHomePath)).toBe(temporary);
    expect(() =>
      programs.beginOperation({
        binaryPath: first,
        sourceHomePath: agentProgramSourceHome(provider, env, sourceHomePath),
      }),
    ).not.toThrow();
  });
});

describe("Claude private config and shared projects epochs", () => {
  const directories: string[] = [];
  const fixture = () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "moss-claude-project-owner-"));
    directories.push(root);
    const first = path.join(root, "first-cli");
    const second = path.join(root, "second-cli");
    writeFileSync(first, "first");
    writeFileSync(second, "second");
    const source = path.join(root, "shared-projects");
    const otherSource = path.join(root, "other-projects");
    const own = path.join(root, "own-private", ".claude");
    const moss = path.join(root, "moss-private", ".claude");
    for (const directory of [source, otherSource, own, moss])
      mkdirSync(directory, { recursive: true });
    const link = (home: string, target = source) =>
      symlinkSync(
        target,
        path.join(home, "projects"),
        process.platform === "win32" ? "junction" : "dir",
      );
    link(own);
    link(moss);
    return { first, second, source, otherSource, own, moss, link };
  };
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  it("keeps shared projects on one program across private accounts and entry points", () => {
    const { first, second, own, moss } = fixture();
    const scope = {};
    const chat = agentProgramsForServer(scope, "claudeAgent");
    const health = agentProgramsForServer(scope, "claudeAgent");
    const managedHomeEnv = buildClaudeInstanceProcessEnv(
      path.dirname(own),
      {
        ANTHROPIC_AUTH_TOKEN: "synthetic-managed-key",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
        ENABLE_TOOL_SEARCH: "true",
      },
      {
        providerInstanceId: "claude_moss",
        baseEnvironment: { CLAUDE_CONFIG_DIR: "ignored-ambient" },
      },
    );
    const explicitConfigEnv = buildClaudeInstanceProcessEnv(
      path.join(path.dirname(moss), "unrelated-home"),
      {
        CLAUDE_CONFIG_DIR: moss,
      },
      { baseEnvironment: { CLAUDE_CONFIG_DIR: "ignored-ambient" } },
    );
    const ownSource = agentProgramSourceHome("claudeAgent", managedHomeEnv, "unused-fallback");
    const mossSource = agentProgramSourceHome("claudeAgent", explicitConfigEnv, "unused-fallback");
    expect(path.normalize(ownSource)).toBe(own);
    expect(path.normalize(mossSource)).toBe(moss);
    const ownProcess = chat.spawn({
      binaryPath: first,
      sourceHomePath: ownSource,
      spawn: () => new EventEmitter(),
    });
    const rejected = vi.fn(() => new EventEmitter());
    expect(() =>
      health.spawn({ binaryPath: second, sourceHomePath: mossSource, spawn: rejected }),
    ).toThrow(/Restart Moss/);
    expect(rejected).not.toHaveBeenCalled();
    const mossProcess = health.spawn({
      binaryPath: first,
      sourceHomePath: mossSource,
      spawn: () => new EventEmitter(),
    });
    ownProcess.emit("close");
    mossProcess.emit("exit");
    expect(() => chat.beginMaintenance(first)).toThrow(/still in use/);
    mossProcess.emit("close");
    mossProcess.emit("close");
    expect(() => chat.beginMaintenance(first).finish(false)).not.toThrow();
    expect(() => health.beginOperation({ binaryPath: second, sourceHomePath: moss })).toThrow(
      /Restart Moss/,
    );
  });

  it("retains the private config epoch when a projects link is changed", () => {
    const { first, second, own, moss, otherSource, link } = fixture();
    const programs = makeAgentProgramOwnership("claudeAgent");
    const process = programs.spawn({
      binaryPath: first,
      sourceHomePath: own,
      spawn: () => new EventEmitter(),
    });
    unlinkSync(path.join(own, "projects"));
    link(own, otherSource);
    expect(() => programs.beginOperation({ binaryPath: second, sourceHomePath: own })).toThrow(
      /Restart Moss/,
    );
    // The new target itself was not claimed by the rejected private-home change.
    unlinkSync(path.join(moss, "projects"));
    link(moss, otherSource);
    expect(() =>
      programs
        .spawn({ binaryPath: second, sourceHomePath: moss, spawn: () => new EventEmitter() })
        .emit("close"),
    ).not.toThrow();
    process.emit("close");
  });

  it("releases both tentative keys on a confirmed spawn failure", () => {
    const { first, second, own, moss } = fixture();
    const programs = makeAgentProgramOwnership("claudeAgent");
    expect(() =>
      programs.spawn({
        binaryPath: first,
        sourceHomePath: own,
        spawn: () => {
          throw new Error("spawn fixture failed");
        },
      }),
    ).toThrow("spawn fixture failed");
    const process = programs.spawn({
      binaryPath: second,
      sourceHomePath: moss,
      spawn: () => new EventEmitter(),
    });
    expect(() => programs.beginOperation({ binaryPath: first, sourceHomePath: own })).toThrow(
      /Restart Moss/,
    );
    process.emit("close");
    expect(() => programs.beginMaintenance(second).finish(false)).not.toThrow();
  });
});
