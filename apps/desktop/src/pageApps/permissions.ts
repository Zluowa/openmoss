// FILE: permissions.ts
// Purpose: Three-tier Page App permission state machine with revision/contentHash invalidation,
//          full-access cascade, explicit denial retention, and 3-tier enterprise policy flags.
// Layer: Desktop pageApps

import {
  PAGE_APP_DESKTOP_POLICY_ENV_KEYS,
  type DesktopPageAppPermissionsSummary,
  type DesktopPageAppPermissionState as ContractPermissionState,
  type PageAppId,
  type PageAppPermissionState,
} from "@moss/contracts";

import { DesktopPageAppStore } from "./store";
import {
  PAGE_APP_DESKTOP_PERMISSIONS,
  PAGE_APP_TIER2_PERMISSIONS,
  type DesktopPageAppPermission,
  type DesktopPageAppPermissionTier,
  type DesktopPageAppPolicyState,
  type DesktopPageAppStoredAnswer,
  type DesktopPageAppTrustKind,
  type StoredDesktopPageAppPermission,
} from "./types";

export const MOSS_POLICY_PAGE_APPS_ENABLED_ENV = PAGE_APP_DESKTOP_POLICY_ENV_KEYS.enabled;
export const MOSS_POLICY_PAGE_APPS_PERMISSIONS_ENV = PAGE_APP_DESKTOP_POLICY_ENV_KEYS.permissions;
export const MOSS_POLICY_PAGE_APPS_FULL_ACCESS_ENV = PAGE_APP_DESKTOP_POLICY_ENV_KEYS.fullAccess;

function parsePolicyFlag(raw: string | undefined, defaultValue = true): boolean {
  if (raw === undefined) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "" || normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  return defaultValue;
}

/** Reads the three enterprise/organization policy switches for Desktop Page Apps. */
export function readDesktopPageAppPolicyState(
  env: NodeJS.ProcessEnv = process.env,
): DesktopPageAppPolicyState {
  const enabled = parsePolicyFlag(env[MOSS_POLICY_PAGE_APPS_ENABLED_ENV], true);
  const permissionsEnabled =
    enabled && parsePolicyFlag(env[MOSS_POLICY_PAGE_APPS_PERMISSIONS_ENV], true);
  const fullAccessEnabled =
    permissionsEnabled && parsePolicyFlag(env[MOSS_POLICY_PAGE_APPS_FULL_ACCESS_ENV], true);
  return { enabled, permissionsEnabled, fullAccessEnabled };
}

/** Maps a desktop permission to its security tier (Tier 2 or Tier 3). */
export function getDesktopPermissionTier(
  permission: DesktopPageAppPermission,
): DesktopPageAppPermissionTier {
  return permission === "full-access" ? 3 : 2;
}

export function isDesktopPageAppPermission(value: unknown): value is DesktopPageAppPermission {
  return (
    typeof value === "string" && (PAGE_APP_DESKTOP_PERMISSIONS as readonly string[]).includes(value)
  );
}

export interface EvaluatePermissionInput {
  readonly accountId: string;
  readonly orgId: string;
  readonly appId: string;
  readonly permission: DesktopPageAppPermission;
  readonly declaredPermissions: readonly DesktopPageAppPermission[];
  readonly currentRevision: number;
  readonly currentContentHash: string | null;
  readonly hasMixedVersions?: boolean | undefined;
  readonly trustKind?: DesktopPageAppTrustKind | undefined;
  readonly policy?: DesktopPageAppPolicyState | undefined;
}

export type PermissionEvaluationReason =
  | "policy_disabled"
  | "mixed_versions"
  | "not_declared"
  | "outside_untrusted"
  | "explicit_denied"
  | "direct_grant"
  | "cascade_full_access"
  | "updated_reapproval"
  | "unasked";

export interface PermissionEvaluation {
  readonly permission: DesktopPageAppPermission;
  readonly tier: DesktopPageAppPermissionTier;
  readonly state: PageAppPermissionState;
  readonly reason: PermissionEvaluationReason;
  readonly isReapproval: boolean;
  readonly declared: boolean;
  readonly storedAnswer: DesktopPageAppStoredAnswer | null;
  readonly coversTier2?: boolean | undefined;
  readonly coveredByFullAccess: boolean;
  readonly runsOn?: readonly string[] | undefined;
  readonly held?: boolean | undefined;
  readonly updatedAt?: string | undefined;
  readonly previousRevision?: number | undefined;
}

export interface SetPermissionInput {
  readonly accountId: string;
  readonly orgId: string;
  readonly appId: string;
  readonly permission: DesktopPageAppPermission;
  readonly answer: DesktopPageAppStoredAnswer | null;
  readonly revision: number;
  readonly contentHash: string | null;
  readonly declaredPermissions?: readonly DesktopPageAppPermission[] | undefined;
  readonly coversTier2?: boolean | undefined;
  readonly now?: string | undefined;
}

export interface SetPermissionResult {
  readonly changed: boolean;
  readonly revokedPermissions: readonly DesktopPageAppPermission[];
  readonly grantedPermissions: readonly DesktopPageAppPermission[];
}

export class DesktopPageAppPermissionEngine {
  readonly store: DesktopPageAppStore;
  private readonly policySource: () => DesktopPageAppPolicyState;

  constructor(
    store: DesktopPageAppStore,
    policySource: () => DesktopPageAppPolicyState = () => readDesktopPageAppPolicyState(),
  ) {
    this.store = store;
    this.policySource = policySource;
  }

  getPolicyState(): DesktopPageAppPolicyState {
    return this.policySource();
  }

  /** Evaluates the effective state of a single permission for a given app revision and hash. */
  evaluate(input: EvaluatePermissionInput): PermissionEvaluation {
    const policy = input.policy ?? this.policySource();
    const tier = getDesktopPermissionTier(input.permission);
    const declared = input.declaredPermissions.includes(input.permission);

    if (
      !policy.enabled ||
      (tier === 2 && !policy.permissionsEnabled) ||
      (tier === 3 && (!policy.permissionsEnabled || !policy.fullAccessEnabled))
    ) {
      return {
        permission: input.permission,
        tier,
        state: "unavailable",
        reason: "policy_disabled",
        isReapproval: false,
        declared,
        storedAnswer: null,
        coveredByFullAccess: false,
      };
    }

    if (input.hasMixedVersions) {
      return {
        permission: input.permission,
        tier,
        state: "unavailable",
        reason: "mixed_versions",
        isReapproval: false,
        declared,
        storedAnswer: null,
        coveredByFullAccess: false,
      };
    }

    if (!declared) {
      return {
        permission: input.permission,
        tier,
        state: "unavailable",
        reason: "not_declared",
        isReapproval: false,
        declared: false,
        storedAnswer: null,
        coveredByFullAccess: false,
      };
    }

    if (input.permission === "full-access" && input.trustKind === "untrusted") {
      return {
        permission: input.permission,
        tier,
        state: "unavailable",
        reason: "outside_untrusted",
        isReapproval: false,
        declared: true,
        storedAnswer: null,
        coveredByFullAccess: false,
      };
    }

    const stored = this.store.getPermission(
      input.accountId,
      input.orgId,
      input.appId,
      input.permission,
    );

    if (stored?.answer === "denied") {
      return {
        permission: input.permission,
        tier,
        state: "denied",
        reason: "explicit_denied",
        isReapproval: false,
        declared: true,
        storedAnswer: "denied",
        coveredByFullAccess: false,
        updatedAt: stored.updatedAt,
      };
    }

    const expectedHash = input.currentContentHash ?? null;
    if (stored?.answer === "granted") {
      const storedHash = stored.contentHash ?? null;
      const matchesVersion =
        stored.revision === input.currentRevision && storedHash === expectedHash;
      if (matchesVersion) {
        return {
          permission: input.permission,
          tier,
          state: "granted",
          reason: "direct_grant",
          isReapproval: false,
          declared: true,
          storedAnswer: "granted",
          coveredByFullAccess: false,
          coversTier2: stored.coversTier2,
          runsOn: stored.runsOn,
          held: stored.held,
          updatedAt: stored.updatedAt,
        };
      }
      return {
        permission: input.permission,
        tier,
        state: "prompt",
        reason: "updated_reapproval",
        isReapproval: true,
        declared: true,
        storedAnswer: "granted",
        coveredByFullAccess: false,
        previousRevision: stored.revision,
        updatedAt: stored.updatedAt,
      };
    }

    if (
      tier === 2 &&
      policy.fullAccessEnabled &&
      input.declaredPermissions.includes("full-access")
    ) {
      const fullAccessRecord = this.store.getPermission(
        input.accountId,
        input.orgId,
        input.appId,
        "full-access",
      );
      if (
        fullAccessRecord?.answer === "granted" &&
        fullAccessRecord.coversTier2 !== false &&
        fullAccessRecord.revision === input.currentRevision &&
        (fullAccessRecord.contentHash ?? null) === expectedHash
      ) {
        return {
          permission: input.permission,
          tier,
          state: "granted",
          reason: "cascade_full_access",
          isReapproval: false,
          declared: true,
          storedAnswer: "granted",
          coveredByFullAccess: true,
          held: true,
          updatedAt: fullAccessRecord.updatedAt,
        };
      }
    }

    return {
      permission: input.permission,
      tier,
      state: "prompt",
      reason: "unasked",
      isReapproval: false,
      declared: true,
      storedAnswer: null,
      coveredByFullAccess: false,
    };
  }

  evaluateAll(
    input: Omit<EvaluatePermissionInput, "permission">,
  ): Record<DesktopPageAppPermission, PermissionEvaluation> {
    const out = {} as Record<DesktopPageAppPermission, PermissionEvaluation>;
    for (const permission of PAGE_APP_DESKTOP_PERMISSIONS) {
      out[permission] = this.evaluate({ ...input, permission });
    }
    return out;
  }

  summarize(input: Omit<EvaluatePermissionInput, "permission">): DesktopPageAppPermissionsSummary {
    const evaluated = this.evaluateAll(input);
    const states: Record<string, PageAppPermissionState> = {};
    const details: Record<string, ContractPermissionState> = {};
    for (const permission of PAGE_APP_DESKTOP_PERMISSIONS) {
      const ev = evaluated[permission];
      states[permission] = ev.state;
      details[permission] = {
        permission,
        tier: ev.tier,
        state: ev.state,
        answer: ev.storedAnswer,
        revision: input.currentRevision,
        contentHash: input.currentContentHash,
        ...(ev.coversTier2 !== undefined ? { coversTier2: ev.coversTier2 } : {}),
        ...(ev.runsOn !== undefined ? { runsOn: [...ev.runsOn] } : {}),
        ...(ev.held !== undefined ? { held: ev.held } : {}),
        stale: ev.isReapproval,
        ...(ev.updatedAt ? { updatedAt: ev.updatedAt } : {}),
      };
    }
    return {
      appId: input.appId as PageAppId,
      revision: input.currentRevision,
      contentHash: input.currentContentHash,
      declared: [...input.declaredPermissions],
      states,
      details,
    };
  }

  /**
   * Persists a permission decision (`"granted"`, `"denied"`, or `null` to reset to prompt).
   * Granting `"full-access"` cascades to all non-denied Tier 2 permissions.
   */
  setPermission(input: SetPermissionInput): SetPermissionResult {
    const now = input.now ?? new Date().toISOString();
    const grantedPermissions: DesktopPageAppPermission[] = [];
    const revokedPermissions: DesktopPageAppPermission[] = [];

    const existing = this.store.getPermission(
      input.accountId,
      input.orgId,
      input.appId,
      input.permission,
    );

    if (input.answer === null) {
      if (existing) {
        this.store.setPermission(input.accountId, input.orgId, input.appId, input.permission, null);
        if (existing.answer === "granted") {
          revokedPermissions.push(input.permission);
        }
      }
      if (input.permission === "full-access") {
        this.clearCascadeGrants(input.accountId, input.orgId, input.appId, revokedPermissions);
      }
      return {
        changed: existing !== null,
        revokedPermissions,
        grantedPermissions,
      };
    }

    const coversTier2 =
      input.permission === "full-access"
        ? input.coversTier2 !== false && input.answer === "granted"
        : undefined;
    const nextRecord: StoredDesktopPageAppPermission = {
      answer: input.answer,
      revision: input.revision,
      contentHash: input.contentHash,
      ...(coversTier2 !== undefined ? { coversTier2 } : {}),
      runsOn: [process.platform],
      updatedAt: now,
    };
    this.store.setPermission(
      input.accountId,
      input.orgId,
      input.appId,
      input.permission,
      nextRecord,
    );

    if (input.answer === "granted") {
      grantedPermissions.push(input.permission);
      if (input.permission === "full-access" && coversTier2) {
        const targets = input.declaredPermissions
          ? PAGE_APP_TIER2_PERMISSIONS.filter((perm: DesktopPageAppPermission) =>
              input.declaredPermissions?.includes(perm),
            )
          : PAGE_APP_TIER2_PERMISSIONS;
        for (const tier2Perm of targets) {
          const currentTier2 = this.store.getPermission(
            input.accountId,
            input.orgId,
            input.appId,
            tier2Perm,
          );
          if (currentTier2?.answer === "denied") {
            continue;
          }
          // Clean up any legacy synthetic `held: true` row; Tier 2 cascades are evaluated dynamically.
          if (currentTier2?.held === true) {
            this.store.setPermission(input.accountId, input.orgId, input.appId, tier2Perm, null);
          }
          const isAlreadyDirect =
            currentTier2?.answer === "granted" &&
            !currentTier2.held &&
            currentTier2.revision === input.revision &&
            (currentTier2.contentHash ?? null) === (input.contentHash ?? null);
          if (!isAlreadyDirect) {
            grantedPermissions.push(tier2Perm);
          }
        }
      }
    } else {
      if (existing?.answer === "granted") {
        revokedPermissions.push(input.permission);
      }
      if (input.permission === "full-access") {
        this.clearCascadeGrants(input.accountId, input.orgId, input.appId, revokedPermissions);
      }
    }

    return {
      changed: true,
      revokedPermissions,
      grantedPermissions,
    };
  }

  private clearCascadeGrants(
    accountId: string,
    orgId: string,
    appId: string,
    revokedOut: DesktopPageAppPermission[],
  ): void {
    for (const tier2Perm of PAGE_APP_TIER2_PERMISSIONS) {
      const record = this.store.getPermission(accountId, orgId, appId, tier2Perm);
      if (record?.answer === "granted" && record.held === true) {
        this.store.setPermission(accountId, orgId, appId, tier2Perm, null);
        revokedOut.push(tier2Perm);
      }
    }
  }
}

export interface PolicyTransition {
  readonly policy: DesktopPageAppPolicyState;
  readonly appFeatureDisabled: boolean;
  readonly permissionsDisabled: boolean;
  readonly fullAccessDisabled: boolean;
}

/** Tracks runtime policy changes and signals immediate enforcement when a policy turns off. */
export class DesktopPageAppPolicyWatcher {
  private lastPolicy: DesktopPageAppPolicyState;
  private readonly readPolicy: () => DesktopPageAppPolicyState;

  constructor(readPolicy: () => DesktopPageAppPolicyState = () => readDesktopPageAppPolicyState()) {
    this.readPolicy = readPolicy;
    this.lastPolicy = readPolicy();
  }

  current(): DesktopPageAppPolicyState {
    return this.lastPolicy;
  }

  poll(): PolicyTransition | null {
    const next = this.readPolicy();
    const appFeatureDisabled = this.lastPolicy.enabled && !next.enabled;
    const permissionsDisabled = this.lastPolicy.permissionsEnabled && !next.permissionsEnabled;
    const fullAccessDisabled = this.lastPolicy.fullAccessEnabled && !next.fullAccessEnabled;
    const changed =
      this.lastPolicy.enabled !== next.enabled ||
      this.lastPolicy.permissionsEnabled !== next.permissionsEnabled ||
      this.lastPolicy.fullAccessEnabled !== next.fullAccessEnabled;
    this.lastPolicy = next;
    if (!changed) return null;
    return {
      policy: next,
      appFeatureDisabled,
      permissionsDisabled,
      fullAccessDisabled,
    };
  }
}
