// FILE: ComputerAppControls.logic.ts
// Purpose: Pure rules behind Settings › Computer use's per-app rows: which apps get a row,
//          and how a switch or an "always allow" choice rewrites the server setting.
// Layer: Settings UI logic
// Exports: ComputerAppRow, buildComputerAppRows, nextComputerAppPolicy, alwaysAllowCandidates

import type { ComputerServerSettings, ComputerUsedApp } from "@moss/contracts";
import {
  computerAppCanBeAlwaysAllowed,
  computerAppIdentityKeys,
  computerAppPolicyKey,
  computerAppPolicyMatch,
  withComputerApp,
  withoutComputerApp,
} from "@moss/shared/computerAppPolicy";

export interface ComputerAppRow {
  /** Stable React key and policy spelling. */
  readonly key: string;
  readonly name: string;
  readonly iconPath?: string | undefined;
  readonly blocked: boolean;
  readonly alwaysAllowed: boolean;
}

/**
 * One row per app Moss has used, newest first, then any app the settings
 * still name that is no longer in that list — a choice the user made never
 * disappears from the page just because the app has not been used lately.
 */
export function buildComputerAppRows(
  usedApps: readonly ComputerUsedApp[],
  policy: ComputerServerSettings,
): ComputerAppRow[] {
  const rows: ComputerAppRow[] = [];
  const seen = new Set<string>();
  const push = (name: string, iconPath: string | undefined, keys: ReadonlySet<string>) => {
    const key = computerAppPolicyKey(name);
    if (key.length === 0 || seen.has(key)) return;
    for (const alias of keys) seen.add(alias);
    seen.add(key);
    rows.push({
      key,
      name,
      iconPath,
      blocked: computerAppPolicyMatch(policy.blockedApps, keys) !== undefined,
      // The server never skips the prompt for these, so the page never says it does.
      alwaysAllowed:
        computerAppCanBeAlwaysAllowed(name) &&
        computerAppPolicyMatch(policy.alwaysAllowedApps, keys) !== undefined,
    });
  };
  for (const app of usedApps) {
    push(
      app.name,
      app.iconPath,
      computerAppIdentityKeys({ name: app.name, bundleId: app.bundleId, path: app.iconPath }),
    );
  }
  for (const name of [...policy.blockedApps, ...policy.alwaysAllowedApps]) {
    push(name, undefined, computerAppIdentityKeys({ name }));
  }
  return rows;
}

/**
 * The setting after one choice. Turning an app off also takes it out of
 * "always allowed" — a blocked app is never asked about, so the two lists
 * never disagree. Allowing an app turns it back on for the same reason.
 */
export function nextComputerAppPolicy(
  policy: ComputerServerSettings,
  change:
    | { readonly kind: "blocked"; readonly app: string; readonly value: boolean }
    | { readonly kind: "always-allowed"; readonly app: string; readonly value: boolean },
): ComputerServerSettings {
  if (change.kind === "blocked") {
    return change.value
      ? {
          blockedApps: withComputerApp(policy.blockedApps, change.app),
          alwaysAllowedApps: withoutComputerApp(policy.alwaysAllowedApps, change.app),
        }
      : {
          blockedApps: withoutComputerApp(policy.blockedApps, change.app),
          alwaysAllowedApps: [...policy.alwaysAllowedApps],
        };
  }
  return change.value
    ? {
        blockedApps: withoutComputerApp(policy.blockedApps, change.app),
        alwaysAllowedApps: withComputerApp(policy.alwaysAllowedApps, change.app),
      }
    : {
        blockedApps: [...policy.blockedApps],
        alwaysAllowedApps: withoutComputerApp(policy.alwaysAllowedApps, change.app),
      };
}

/**
 * The apps the "Add" menu offers: turned on, not already always allowed, and
 * allowed to skip the prompt at all (never Windows Settings or Control Panel).
 */
export function alwaysAllowCandidates(rows: readonly ComputerAppRow[]): ComputerAppRow[] {
  return rows.filter(
    (row) => !row.blocked && !row.alwaysAllowed && computerAppCanBeAlwaysAllowed(row.name),
  );
}
