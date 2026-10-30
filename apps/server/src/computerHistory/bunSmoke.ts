import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EncryptedComputerHistoryAuditStore, EncryptedComputerHistoryStore } from "./store.ts";

const rootDir = await mkdtemp(join(tmpdir(), "moss-history-bun-smoke-"));
const key = Buffer.alloc(32, 0x42);
const keyProvider = { getOrCreateKey: async () => key };
const observation = {
  capturedAtMs: 1_700_000_000_000,
  app: { bundleIdentifier: "com.example.editor", name: "Editor" },
  window: { title: "bun smoke sensitive title" },
  activityText: "bun smoke private draft",
};

try {
  const store = new EncryptedComputerHistoryStore(rootDir, keyProvider);
  await store.append(observation);
  const restoredStore = new EncryptedComputerHistoryStore(rootDir, keyProvider);
  await restoredStore.load();
  assert.equal(restoredStore.loadedRecords.length, 1);
  assert.equal(restoredStore.loadedRecords[0]?.observation.window.title, observation.window.title);
  assert.equal(restoredStore.loadedRecords[0]?.observation.activityText, "[redacted activity]");

  const audit = new EncryptedComputerHistoryAuditStore(rootDir, keyProvider);
  await audit.append({
    atMs: observation.capturedAtMs,
    tool: "history_query",
    callerThreadId: "bun-smoke-caller",
    callerProvider: "bun-smoke-provider",
    resultCount: 1,
  });
  const restoredAudit = new EncryptedComputerHistoryAuditStore(rootDir, keyProvider);
  await restoredAudit.load();
  assert.equal(restoredAudit.loadedRecords.length, 1);

  const eventCiphertext = await readFile(store.eventsPath, "utf8");
  const auditCiphertext = await readFile(audit.auditPath, "utf8");
  assert.equal(eventCiphertext.includes("bun smoke sensitive title"), false);
  assert.equal(eventCiphertext.includes("bun smoke private draft"), false);
  assert.equal(auditCiphertext.includes("bun-smoke-caller"), false);
  assert.equal(auditCiphertext.includes("bun-smoke-provider"), false);
  console.log("Computer History Bun AES-GCM smoke: PASS");
} finally {
  await rm(rootDir, { recursive: true, force: true });
}
