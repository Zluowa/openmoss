import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import {
  canonicalizeCodexHomeIdentityPath,
  readCodexCredentialFence,
} from "../codexHomeIdentity.ts";
import { buildCodexProcessEnv } from "../codexProcessEnv.ts";
import {
  codexStateBindingReference,
  makeCodexStateBindingAccess,
  type CodexStateBindingAccount,
} from "./codexStateBinding.ts";

let root: string;
let stateDir: string;
let account: CodexStateBindingAccount;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "moss-state-binding-"));
  stateDir = path.join(root, "server-state");
  account = {
    providerInstanceId: "codex_work",
    accountId: "work",
    enabled: true,
    sourceHomePath: path.join(root, "source"),
    privateHomePath: path.join(root, "private"),
    runtimeGeneration: "account-generation-1",
  };
  for (const directory of [stateDir, account.sourceHomePath, account.privateHomePath]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  writeFileSync(
    path.join(account.privateHomePath, "config.toml"),
    'model = "private-model"\n',
    "utf8",
  );
  writeFileSync(
    path.join(account.privateHomePath, "auth.json"),
    '{"account":"synthetic-work"}',
    "utf8",
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const owner = () => ({
  providerInstanceId: account.providerInstanceId,
  accountId: account.accountId,
});
const restoreInput = (reference: string) => ({
  ...owner(),
  reference,
  expectedReference: reference,
});
const makeAccess = (
  readAccount: (id: string) => CodexStateBindingAccount | undefined = (id) =>
    id === account.providerInstanceId ? account : undefined,
) =>
  Effect.runPromise(
    makeCodexStateBindingAccess({
      stateDir,
      runtimeHomePath: path.join(root, "runtime"),
      readAccount,
    }).pipe(
      Effect.provide(
        ServerSecretStoreLive.pipe(
          Layer.provide(
            ServerConfig.layerTest(root, path.join(root, "server"), {
              stateDir,
              secretsDir: path.join(stateDir, "secrets"),
            }),
          ),
          Layer.provide(NodeServices.layer),
        ),
      ),
      Effect.scoped,
    ),
  );

describe("server Codex state binding receipts", () => {
  it("declines launch when the account is disabled while reading the credential revision", async () => {
    const { runtimeGeneration: _, ...ownAccount } = account;
    account = ownAccount;
    const registry = await makeAccess();
    const registered = await registry.register(owner());
    const restoring = registry.restoreLaunch(restoreInput(registered.reference));
    account = { ...account, enabled: false };
    await expect(restoring).rejects.toThrow(/账户设置|停用/);
    expect(registry.restoreStop(restoreInput(registered.reference))?.reference).toBe(
      registered.reference,
    );
  });
  it("rebinds a verified old owner to an independently selected account without replacing its source", async () => {
    const originalOwner = owner();
    const registry = await makeAccess();
    const registered = await registry.register(originalOwner);
    const nextPrivate = path.join(root, "target-private");
    const nextSource = path.join(root, "target-source");
    mkdirSync(nextPrivate);
    mkdirSync(nextSource);
    account = {
      ...account,
      providerInstanceId: "codex_other",
      accountId: "other",
      privateHomePath: nextPrivate,
      sourceHomePath: nextSource,
    };
    const prior = {
      ...originalOwner,
      reference: registered.reference,
      expectedReference: registered.reference,
    };
    await expect(registry.restoreLaunch({ ...prior, ...owner() })).rejects.toThrow(/不属于/);
    const rebound = (await registry.rebind(prior, owner()))!;
    expect(rebound.options.homePath).toBe(registered.options.homePath);
    expect(rebound.sourceGeneration).toBe(registered.sourceGeneration);
    expect(rebound.options.shadowHomePath).toBe(canonicalizeCodexHomeIdentityPath(nextPrivate));
    expect(rebound.options.accountId).toBe("other");
    expect(registry.restoreStop(prior)?.options.accountId).toBe("work");
    expect(() =>
      registry.restoreStop({
        ...prior,
        reference: rebound.reference,
        expectedReference: rebound.reference,
      }),
    ).toThrow(/不属于/);
    account = { ...account, enabled: false };
    await expect(registry.rebind(prior, owner())).rejects.toThrow(/停用/);
  });

  it("exposes a durable reference only for the issued server capability", async () => {
    const registry = await makeAccess();
    const registered = await registry.register(owner());
    expect(codexStateBindingReference(registered.options)).toBe(registered.reference);
    expect(codexStateBindingReference(undefined)).toBeUndefined();
    const { credentialFence: _fence, ...withoutCapability } = registered.options;
    expect(codexStateBindingReference(withoutCapability)).toBeUndefined();
    expect(() =>
      codexStateBindingReference(JSON.parse(JSON.stringify(registered.options))),
    ).toThrow();
    const restarted = await makeAccess();
    const restored = restarted.restoreStop(restoreInput(registered.reference))!;
    expect(codexStateBindingReference(restored.options)).toBe(registered.reference);
  });

  it("derives a stable ordinary account generation without depending on request fields", async () => {
    const { runtimeGeneration: _, ...ownAccount } = account;
    account = ownAccount;
    const registry = await makeAccess();
    const registered = await registry.register(owner());
    const restarted = await makeAccess();
    expect((await restarted.restoreLaunch(restoreInput(registered.reference)))?.reference).toBe(
      registered.reference,
    );
    expect((await restarted.renew(restoreInput(registered.reference)))?.reference).toBe(
      registered.reference,
    );
    expect((await restarted.register(owner())).reference).toBe(registered.reference);
  });

  it("restores through a fresh server secret-store instance and retains an old source after settings change", async () => {
    const first = await makeAccess();
    const registered = await first.register(owner());
    const originalSource = account.sourceHomePath;
    const nextSource = path.join(root, "next-source");
    mkdirSync(nextSource);
    account = { ...account, sourceHomePath: nextSource };
    const restarted = await makeAccess();
    const restored = (await restarted.restoreLaunch(restoreInput(registered.reference)))!;
    expect(restored.options.homePath).toBe(canonicalizeCodexHomeIdentityPath(originalSource));
    expect(restored.sourceGeneration).toBe(registered.sourceGeneration);
    expect(readCodexCredentialFence(restored.options)).toBeDefined();
    expect(await restarted.restoreLaunch(owner())).toBeUndefined();
    const next = await restarted.register(owner());
    expect(next.reference).not.toBe(registered.reference);
    expect(next.options.homePath).toBe(canonicalizeCodexHomeIdentityPath(nextSource));
  });

  it.each(["source-moved", "source-replaced", "private-replaced"])(
    "rejects a changed directory identity: %s",
    async (change) => {
      const registry = await makeAccess();
      const registered = await registry.register(owner());
      const original =
        change === "private-replaced" ? account.privateHomePath : account.sourceHomePath;
      renameSync(original, path.join(root, "retained-original"));
      if (change !== "source-moved") mkdirSync(original);
      await expect(registry.restoreLaunch(restoreInput(registered.reference))).rejects.toThrow();
      expect(() => registry.restoreStop(restoreInput(registered.reference))).toThrow();
      expect(() => readCodexCredentialFence(registered.options)).toThrow();
    },
  );

  it("rejects forged, cross-account, and conflicting thread references", async () => {
    const registry = await makeAccess();
    const registered = await registry.register(owner());
    await expect(
      registry.restoreLaunch({ ...restoreInput(registered.reference), accountId: "moss" }),
    ).rejects.toThrow(/不属于/);
    await expect(
      registry.restoreLaunch({
        ...restoreInput(registered.reference),
        providerInstanceId: "codex_moss",
      }),
    ).rejects.toThrow(/不属于/);
    await expect(
      registry.restoreLaunch({
        ...restoreInput(registered.reference),
        expectedReference: "0".repeat(64),
      }),
    ).rejects.toThrow(/当前对话不一致/);
    await expect(
      registry.restoreLaunch({ ...owner(), reference: registered.reference }),
    ).rejects.toThrow(/当前对话不一致/);
    const recordPath = path.join(
      stateDir,
      "agent-state-bindings",
      "codex",
      `${registered.reference}.json`,
    );
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    record.record.accountId = "moss";
    writeFileSync(recordPath, JSON.stringify(record), "utf8");
    expect(() => registry.restoreStop(restoreInput(registered.reference))).toThrow(/无法验证/);
  });

  it("rejects disabled or rotated launches while retaining ownership for stop and private credential cleanup", async () => {
    const registry = await makeAccess();
    const registered = await registry.register(owner());
    account = { ...account, enabled: false, runtimeGeneration: "account-generation-2" };
    await expect(registry.restoreLaunch(restoreInput(registered.reference))).rejects.toThrow(
      /停用/,
    );
    const stopped = registry.restoreStop(restoreInput(registered.reference))!;
    expect(readCodexCredentialFence(stopped.options)).toBeDefined();
    expect(stopped.options.runtimeGeneration).toBe("account-generation-1");
    rmSync(path.join(account.privateHomePath, "auth.json"));
    expect(readCodexCredentialFence(stopped.options)).toBeDefined();
    const env = await buildCodexProcessEnv({
      ...stopped.options,
      env: stopped.options.environment,
    });
    expect(() => readFileSync(path.join(env.CODEX_HOME!, "auth.json"))).toThrow();
    account = { ...account, enabled: true };
    await expect(registry.restoreLaunch(restoreInput(registered.reference))).rejects.toThrow(
      /绑定已更换/,
    );
  });

  it("bounds a damaged record before parsing its contents", async () => {
    const registry = await makeAccess();
    const registered = await registry.register(owner());
    writeFileSync(
      path.join(stateDir, "agent-state-bindings", "codex", `${registered.reference}.json`),
      " ".repeat(8_193),
      "utf8",
    );
    let failure: unknown;
    try {
      registry.restoreStop(restoreInput(registered.reference));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      failure: "file-read-failed",
      cause: { message: "Codex metadata exceeds its bounded read limit." },
    });
  });

  it("refuses a new private home at launch while retaining the old registered stop target", async () => {
    const registry = await makeAccess();
    const registered = await registry.register(owner());
    const privateHomePath = path.join(root, "new-private");
    mkdirSync(privateHomePath);
    account = { ...account, privateHomePath };
    await expect(registry.restoreLaunch(restoreInput(registered.reference))).rejects.toThrow(
      /绑定已更换/,
    );
    expect(registry.restoreStop(restoreInput(registered.reference))?.options.shadowHomePath).toBe(
      registered.options.shadowHomePath,
    );
  });

  it.each([false, true])(
    "renews current credentials on the signed old source (old private removed: %s)",
    async (removeOldPrivate) => {
      const registry = await makeAccess();
      const registered = await registry.register(owner());
      const source = registered.options.homePath;
      const historyFile = path.join(source, "sessions", "native-session.jsonl");
      writeFileSync(historyFile, "original-native-history", "utf8");
      const privateHomePath = path.join(root, "renewed-private");
      const sourceHomePath = path.join(root, "new-global-source");
      mkdirSync(privateHomePath);
      mkdirSync(sourceHomePath);
      writeFileSync(path.join(privateHomePath, "config.toml"), 'model = "renewed-model"\n', "utf8");
      if (removeOldPrivate) rmSync(account.privateHomePath, { recursive: true });
      account = {
        ...account,
        privateHomePath,
        sourceHomePath,
        runtimeGeneration: "account-generation-2",
      };
      const renewed = (await registry.renew(restoreInput(registered.reference)))!;
      expect(renewed.reference).not.toBe(registered.reference);
      expect(renewed.options.homePath).toBe(source);
      expect(renewed.options.shadowHomePath).toBe(
        canonicalizeCodexHomeIdentityPath(privateHomePath),
      );
      expect(renewed.sourceGeneration).toBe(registered.sourceGeneration);
      expect(renewed.options.runtimeGeneration).toBe("account-generation-2");
      expect(readFileSync(historyFile, "utf8")).toBe("original-native-history");
      if (!removeOldPrivate)
        expect(registry.restoreStop(restoreInput(registered.reference))).toBeDefined();
      const restarted = await makeAccess();
      expect(
        (await restarted.restoreLaunch(restoreInput(renewed.reference)))?.options.homePath,
      ).toBe(source);
      expect(await restarted.renew(owner())).toBeUndefined();
    },
  );

  it("does not renew a disabled account, a forged owner, or an unexpected same-path replacement", async () => {
    const registry = await makeAccess();
    const registered = await registry.register(owner());
    account = { ...account, enabled: false, runtimeGeneration: "account-generation-2" };
    await expect(registry.renew(restoreInput(registered.reference))).rejects.toThrow(/停用/);
    account = { ...account, enabled: true, runtimeGeneration: "account-generation-1" };
    await expect(
      registry.renew({ ...restoreInput(registered.reference), accountId: "moss" }),
    ).rejects.toThrow(/不属于/);
    renameSync(account.privateHomePath, path.join(root, "old-private"));
    mkdirSync(account.privateHomePath);
    await expect(registry.renew(restoreInput(registered.reference))).rejects.toThrow(/替换/);
    account = { ...account, runtimeGeneration: "account-generation-2" };
    await expect(registry.renew(restoreInput(registered.reference))).rejects.toThrow(/替换/);
  });

  it("never recreates a damaged old source generation during renewal", async () => {
    const registry = await makeAccess();
    const registered = await registry.register(owner());
    const markerPath = path.join(account.sourceHomePath, "moss-shared-continuation-v2.json");
    writeFileSync(markerPath, "{}", "utf8");
    account = { ...account, runtimeGeneration: "account-generation-2" };
    await expect(registry.renew(restoreInput(registered.reference))).rejects.toThrow(
      /历史来源已更换/,
    );
    expect(readFileSync(markerPath, "utf8")).toBe("{}");
  });
});
