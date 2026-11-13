// FILE: computerAppPolicy.ts
// Purpose: Settings › Computer use per-app choices on the server — the refusal an agent
//          reads when it reaches a turned-off app, the "always allowed" lookup the
//          approval path asks, and the small local record of apps agents have driven.
// Layer: Server computer runtime
// Exports: ComputerAppBlockedError, ComputerAppPolicy, ComputerUsedAppsStore,
//          EMPTY_COMPUTER_APP_POLICY

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { COMPUTER_USED_APPS_MAX, type ComputerUsedApp } from "@moss/contracts";
import { computerAppIdentityKeys, computerAppPolicyKey } from "@moss/shared/computerAppPolicy";

import { ComputerTargetError } from "./uiTreeTargeting.ts";

export interface ComputerAppPolicy {
  readonly blockedApps: readonly string[];
  readonly alwaysAllowedApps: readonly string[];
}

export const EMPTY_COMPUTER_APP_POLICY: ComputerAppPolicy = {
  blockedApps: [],
  alwaysAllowedApps: [],
};

/** An app identity as one surface reports it; every field optional. */
export interface ComputerAppIdentity {
  readonly name?: string | undefined;
  readonly bundleId?: string | undefined;
  readonly path?: string | undefined;
  /**
   * The process that owns the window, when it differs from the app the window
   * names (a shared host such as ApplicationFrameHost). Used to block, never
   * to allow.
   */
  readonly processName?: string | undefined;
}

/**
 * The refusal for an app the user turned off in Settings › Computer use.
 * Written for the agent: it says nothing was sent, that the choice is the
 * user's, and what to do instead, so the model stops rather than retrying
 * through another spelling of the same app. It extends `ComputerTargetError`
 * so the gateway's target-error branch keeps the code on the wire.
 */
export class ComputerAppBlockedError extends ComputerTargetError {
  readonly app: string;

  constructor(app: string) {
    super({
      code: "computer_app_blocked",
      message:
        `${app} is turned off in Moss Settings › Computer use, so Moss did not open, read or ` +
        "control it and sent no input. This is the user's choice: do not retry it or reach it " +
        "another way. Tell the user it is turned off, or continue without it.",
    });
    this.name = "ComputerAppBlockedError";
    this.app = app;
  }
}

interface StoredUsedApp {
  readonly name: string;
  readonly bundleId?: string;
  readonly iconPath?: string;
  readonly processName?: string;
  readonly lastUsedAt: string;
}

function parseStoredUsedApps(raw: unknown): StoredUsedApp[] {
  if (raw === null || typeof raw !== "object") return [];
  const apps = (raw as { apps?: unknown }).apps;
  if (!Array.isArray(apps)) return [];
  const out: StoredUsedApp[] = [];
  for (const value of apps) {
    if (value === null || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    if (typeof record.name !== "string") continue;
    const name = record.name.trim().slice(0, 256);
    if (name.length === 0 || typeof record.lastUsedAt !== "string") continue;
    if (!Number.isFinite(Date.parse(record.lastUsedAt))) continue;
    out.push({
      name,
      ...(typeof record.bundleId === "string" ? { bundleId: record.bundleId.slice(0, 512) } : {}),
      ...(typeof record.iconPath === "string" ? { iconPath: record.iconPath.slice(0, 4_096) } : {}),
      ...(typeof record.processName === "string"
        ? { processName: record.processName.slice(0, 256) }
        : {}),
      lastUsedAt: new Date(record.lastUsedAt).toISOString(),
    });
    if (out.length >= COMPUTER_USED_APPS_MAX) break;
  }
  return out;
}

/** A pid placeholder or a window id is not an app name worth listing. */
function isListableAppName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && !/^pid \d+$/i.test(trimmed);
}

/**
 * The apps agents have driven, newest first, at most {@link COMPUTER_USED_APPS_MAX}.
 * Local only — beside the control state — and holds names, bundle ids and an
 * icon path, never window titles or content. It doubles as an alias table:
 * one app reported as `Google Chrome` by its window and `chrome` by the
 * process list is one row, so a choice made on either spelling holds for both.
 *
 * Writes are serialized on a promise chain and swallowed on failure: this is a
 * convenience list, and a full disk must never fail the action it records.
 */
export class ComputerUsedAppsStore {
  private apps: StoredUsedApp[] = [];
  private loaded: Promise<void> | undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string | undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      if (this.filePath === undefined) return;
      try {
        const loaded = parseStoredUsedApps(JSON.parse(await readFile(this.filePath, "utf8")));
        // Anything recorded before the file finished loading is newer.
        const seen = new Set(this.apps.map((app) => computerAppPolicyKey(app.name)));
        this.apps = [
          ...this.apps,
          ...loaded.filter((app) => !seen.has(computerAppPolicyKey(app.name))),
        ].slice(0, COMPUTER_USED_APPS_MAX);
      } catch {
        // Missing or unreadable: start empty.
      }
    })();
    return this.loaded;
  }

  /** Starts the load so alias lookups work early; never throws. */
  warm(): void {
    void this.load();
  }

  /** Note one use. Sync and fire-and-forget. */
  record(identity: ComputerAppIdentity): void {
    const name = identity.name?.trim();
    if (name === undefined || !isListableAppName(name)) return;
    const keys = computerAppIdentityKeys({ ...identity, name });
    const previous = this.apps.find((app) =>
      [
        ...computerAppIdentityKeys({ name: app.name, bundleId: app.bundleId, path: app.iconPath }),
      ].some((key) => keys.has(key)),
    );
    const bundleId = identity.bundleId ?? previous?.bundleId;
    const iconPath = identity.path ?? previous?.iconPath;
    // Identity metadata only, never a merge key: a shared host would merge rows.
    const processName = identity.processName ?? previous?.processName;
    const next: StoredUsedApp = {
      // The first spelling seen stays the row's name and policy key.
      name: previous?.name ?? name.slice(0, 256),
      ...(bundleId ? { bundleId: bundleId.slice(0, 512) } : {}),
      ...(iconPath ? { iconPath: iconPath.slice(0, 4_096) } : {}),
      ...(processName ? { processName: processName.slice(0, 256) } : {}),
      lastUsedAt: this.now().toISOString(),
    };
    this.apps = [next, ...this.apps.filter((app) => app !== previous)].slice(
      0,
      COMPUTER_USED_APPS_MAX,
    );
    this.schedulePersist();
  }

  /** Every key known for the app an identity names, its aliases included. */
  expandKeys(identity: ComputerAppIdentity): ReadonlySet<string> {
    const keys = new Set(computerAppIdentityKeys(identity));
    for (const app of this.apps) {
      const appKeys = computerAppIdentityKeys({
        name: app.name,
        bundleId: app.bundleId,
        path: app.iconPath,
      });
      if ([...appKeys].some((key) => keys.has(key))) for (const key of appKeys) keys.add(key);
    }
    return keys;
  }

  async list(): Promise<readonly ComputerUsedApp[]> {
    await this.load();
    await this.chain;
    return this.apps.map((app) => ({
      name: app.name,
      ...(app.bundleId !== undefined ? { bundleId: app.bundleId } : {}),
      ...(app.iconPath !== undefined ? { iconPath: app.iconPath } : {}),
      ...(app.processName !== undefined ? { processName: app.processName } : {}),
      lastUsedAt: app.lastUsedAt,
    }));
  }

  /**
   * The identity recorded for the app a display name names, for deciding
   * "always allowed" when the call itself carries only that name.
   */
  identityForName(name: string): ComputerAppIdentity | undefined {
    const key = computerAppPolicyKey(name);
    const app = this.apps.find((candidate) => computerAppPolicyKey(candidate.name) === key);
    return app === undefined
      ? undefined
      : {
          name: app.name,
          bundleId: app.bundleId,
          path: app.iconPath,
          processName: app.processName,
        };
  }

  async flush(): Promise<void> {
    await this.chain;
  }

  private schedulePersist(): void {
    const filePath = this.filePath;
    if (filePath === undefined) return;
    this.chain = this.chain
      .then(() => this.load())
      .then(async () => {
        const temporaryPath = `${filePath}.tmp`;
        await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
        await writeFile(temporaryPath, `${JSON.stringify({ version: 1, apps: this.apps })}\n`, {
          mode: 0o600,
        });
        await rename(temporaryPath, filePath);
      })
      .catch(() => undefined);
  }
}
