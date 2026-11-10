import { createHmac } from "node:crypto";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  agentStateDirectoryIdentity,
  makeAgentStateBindingRecords,
} from "./agentStateBindingRecords.ts";

// Windows prevents renaming a parent while its staging fd is open. Inject
// only the replacement timing, after the real close and before revalidation.
const stageClose = vi.hoisted(() => ({
  after: undefined as ((stage: string) => void) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    async open(...args: Parameters<typeof fs.open>) {
      const handle = await fs.open(...args);
      if (stageClose.after && typeof args[0] === "string" && args[0].endsWith(".tmp")) {
        const stage = args[0],
          close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          stageClose.after?.(stage);
        };
      }
      return handle;
    },
  };
});

it("reads and reproduces the original Codex v1 receipt wire format", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "moss-binding-wire-"));
  try {
    const server = agentStateDirectoryIdentity(root, "Codex");
    const key = Buffer.from("synthetic-compatibility-key");
    const record = {
      version: 1 as const,
      provider: "codex" as const,
      providerInstanceId: "codex_fixture",
      accountId: "fixture",
      server,
      source: server,
      private: server,
      sourceGeneration: "source-v1",
      runtimeGeneration: "account-v1",
    };
    // This is the pre-extraction persisted envelope, written independently of
    // the new IO helper. Neither its key namespace nor property order changes.
    const signature = createHmac("sha256", key)
      .update("signature\n" + JSON.stringify(record))
      .digest("hex");
    const reference = createHmac("sha256", key)
      .update("reference\n" + JSON.stringify(record))
      .digest("hex");
    const directory = path.join(root, "agent-state-bindings", "codex");
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${reference}.json`);
    const original = JSON.stringify({ record, signature });
    writeFileSync(file, original);
    const store = makeAgentStateBindingRecords<typeof record>({
      provider: "codex",
      key,
      server,
      label: "Codex",
    });
    expect(store.read(reference)).toEqual(record);
    expect(await store.publish(record)).toBe(reference);
    expect(readFileSync(file, "utf8")).toBe(original);
    const claude = makeAgentStateBindingRecords({
      provider: "claudeAgent",
      key,
      server,
      label: "Claude",
    });
    await expect(claude.publish(record as never)).rejects.toThrow(/不一致/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("publishes concurrent immutable records once and preserves an existing receipt's inode", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "moss-binding-concurrent-"));
  try {
    const server = agentStateDirectoryIdentity(root, "Claude");
    const record = { version: 1 as const, provider: "claudeAgent" as const, server };
    const store = () =>
      makeAgentStateBindingRecords<typeof record>({
        provider: "claudeAgent",
        key: Buffer.from("synthetic-publish"),
        server,
        label: "Claude",
      });
    const refs = await Promise.all(Array.from({ length: 8 }, () => store().publish(record)));
    expect(new Set(refs).size).toBe(1);
    const directory = path.join(root, "agent-state-bindings", "claudeAgent");
    const name = refs[0]! + ".json",
      file = path.join(directory, name);
    const before = lstatSync(file, { bigint: true }),
      bytes = readFileSync(file);
    await Promise.all(Array.from({ length: 8 }, () => store().publish(record)));
    const after = lstatSync(file, { bigint: true });
    expect([after.ino, after.mtimeNs, after.nlink]).toEqual([before.ino, before.mtimeNs, 1n]);
    expect(readFileSync(file)).toEqual(bytes);
    expect(store().read(refs[0]!)).toEqual(record);
    expect(readdirSync(directory)).toEqual([name]);
    // Models the instant after link(stage, final) and before unlink(stage),
    // including a crashed publisher. Both aliases are proven private.
    const stage = path.join(directory, `.${refs[0]}.f9b6332a-4130-4aa9-8702-d1649479cf5e.tmp`);
    linkSync(file, stage);
    expect(store().read(refs[0]!)).toEqual(record);
    expect(await store().publish(record)).toBe(refs[0]);
    expect(lstatSync(stage, { bigint: true }).nlink).toBe(2n);
    unlinkSync(stage);
    expect(store().read(refs[0]!)).toEqual(record);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("rejects corrupt or linked immutable destinations instead of overwriting them", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "moss-binding-destination-"));
  try {
    const state = path.join(root, "server");
    mkdirSync(state);
    const server = agentStateDirectoryIdentity(state, "Claude");
    const record = { version: 1 as const, provider: "claudeAgent" as const, server };
    const store = makeAgentStateBindingRecords<typeof record>({
      provider: "claudeAgent",
      key: Buffer.from("synthetic-publish"),
      server,
      label: "Claude",
    });
    const reference = await store.publish(record);
    const file = path.join(state, "agent-state-bindings", "claudeAgent", reference + ".json");
    const original = readFileSync(file);
    const corrupt = JSON.stringify({ record, signature: "a".repeat(64) });
    writeFileSync(file, corrupt);
    await expect(store.publish(record)).rejects.toThrow(/无法验证/);
    expect(readFileSync(file, "utf8")).toBe(corrupt);
    unlinkSync(file);
    const outside = path.join(root, "outside-receipt");
    writeFileSync(outside, original);
    linkSync(outside, file);
    await expect(store.publish(record)).rejects.toThrow();
    expect(readFileSync(outside)).toEqual(original);
    expect(lstatSync(file, { bigint: true }).ino).toBe(lstatSync(outside, { bigint: true }).ino);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("keeps a replacement parent and a foreign staging entry untouched during immutable publication", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "moss-binding-swap-"));
  try {
    const state = path.join(root, "server");
    mkdirSync(state);
    const server = agentStateDirectoryIdentity(state, "Claude");
    const record = { version: 1 as const, provider: "claudeAgent" as const, server };
    const store = makeAgentStateBindingRecords<typeof record>({
      provider: "claudeAgent",
      key: Buffer.from("synthetic-publish"),
      server,
      label: "Claude",
    });
    const bindings = path.join(state, "agent-state-bindings");
    const directory = path.join(bindings, "claudeAgent");
    let stage: string | undefined;
    // Move the original private directory under the same server, without
    // following links. A different publisher's entry now occupies its path.
    stageClose.after = (stagePath) => {
      stageClose.after = undefined;
      stage = path.basename(stagePath);
      renameSync(bindings, path.join(state, "original-bindings"));
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, stage!), "another publisher owns this");
    };
    await expect(store.publish(record)).rejects.toThrow(/移动或被替换/);
    expect(readdirSync(directory)).toEqual([stage]);
    expect(readFileSync(path.join(directory, stage!), "utf8")).toBe("another publisher owns this");
  } finally {
    stageClose.after = undefined;
    rmSync(root, { recursive: true, force: true });
  }
});

it("rejects a linked record-store ancestor before reading or writing outside the server", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "moss-binding-ancestor-"));
  try {
    const state = path.join(root, "server-state");
    mkdirSync(state);
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    const outsideProvider = path.join(outside, "codex");
    mkdirSync(outsideProvider);
    const reference = "a".repeat(64);
    const sentinel = path.join(outsideProvider, `${reference}.json`);
    writeFileSync(sentinel, "outside fixture must remain untouched");
    symlinkSync(
      outside,
      path.join(state, "agent-state-bindings"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const server = agentStateDirectoryIdentity(state, "Codex");
    const key = Buffer.from("synthetic-ancestor-key");
    const record = { version: 1 as const, provider: "codex" as const, server };
    const store = makeAgentStateBindingRecords<typeof record>({
      provider: "codex",
      key,
      server,
      label: "Codex",
    });
    expect(() => store.read(reference)).toThrow(/绑定目录/);
    await expect(store.publish(record)).rejects.toThrow(/绑定目录/);
    expect(readdirSync(outside)).toEqual(["codex"]);
    expect(readdirSync(outsideProvider)).toEqual([`${reference}.json`]);
    expect(readFileSync(sentinel, "utf8")).toBe("outside fixture must remain untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
