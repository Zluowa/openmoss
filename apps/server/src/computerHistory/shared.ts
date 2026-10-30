import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import {
  makeComputerHistoryService,
  type ComputerHistoryService,
  type ComputerHistoryServiceOptions,
} from "./service.ts";

/**
 * The WebSocket RPC surface and the Agent Gateway run in the same server
 * process. Keep one service per canonical MOSS_HOME so lifecycle state,
 * helper ownership, the write queue, and the encrypted store are shared.
 *
 * This is deliberately process-scoped rather than a module-level singleton
 * with one arbitrary home directory: tests and embedded servers may host
 * more than one isolated home in one process.
 */
const servicesByRoot = new Map<string, ComputerHistoryService>();

/**
 * Computer History belongs to the resolved per-runtime state directory
 * (baseDir/userdata or baseDir/dev), never to the OS home directory.
 * Both the WS RPC and Agent Gateway call this same resolver.
 */
export function resolveProcessComputerHistoryRoot(stateDir: string): string {
  return resolve(join(stateDir, "computer-history"));
}

/**
 * Keychain records are scoped to the same canonical runtime profile as the
 * encrypted store. Only this bounded digest label crosses the helper
 * boundary; the user's filesystem path is never passed to or logged by the
 * native helper.
 */
export function resolveProcessComputerHistoryKeychainNamespace(stateDir: string): string {
  const digest = createHash("sha256").update(resolve(stateDir), "utf8").digest("hex");
  return `moss-history-${digest.slice(0, 32)}`;
}

export function getProcessComputerHistoryService(
  options: ComputerHistoryServiceOptions,
): ComputerHistoryService {
  const rootDir = resolve(options.rootDir);
  const existing = servicesByRoot.get(rootDir);
  if (existing) return existing;
  const service = makeComputerHistoryService({ ...options, rootDir });
  servicesByRoot.set(rootDir, service);
  return service;
}

/** Test-only isolation hook; production never clears a live service. */
export function clearProcessComputerHistoryServices(): void {
  servicesByRoot.clear();
}
