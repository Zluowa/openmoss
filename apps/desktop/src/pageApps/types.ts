// FILE: types.ts
// Purpose: Re-exports shared Page App desktop contracts and defines main-process storage types.
// Layer: Desktop pageApps

import type {
  DesktopPageAppInstallPlace,
  DesktopPageAppInstallState,
  DesktopPageAppPolicyState,
  DesktopPageAppScreenDisplay,
  DesktopPageAppWindowGetOptionsResult,
  DesktopPageAppWindowOptions,
  DesktopPageAppWindowPlaceInput,
  DesktopPageAppWindowSetOptionsResult,
  InstalledDesktopPageApp as ContractInstalledDesktopPageApp,
  PageAppDesktopPermission,
  PageAppDesktopPermissionTier,
  PageAppDesktopSourceTrust,
  PageAppDesktopTier2Permission,
} from "@moss/contracts";
import {
  getPageAppDesktopMethodTier,
  PAGE_APP_DESKTOP_AUMID_PREFIX,
  PAGE_APP_DESKTOP_CONFIRM_COOLDOWN_MS,
  PAGE_APP_DESKTOP_DIALOG_PARTITION,
  PAGE_APP_DESKTOP_DRAG_REGIONS_CHANNEL,
  PAGE_APP_DESKTOP_EXEC_MAX_BUFFER_BYTES,
  PAGE_APP_DESKTOP_FS_MAX_READ_BYTES,
  PAGE_APP_DESKTOP_INSTALL_ID_PATTERN,
  PAGE_APP_DESKTOP_LAUNCH_ARG_PREFIX,
  PAGE_APP_DESKTOP_MAX_DRAG_REGIONS,
  PAGE_APP_DESKTOP_MAX_PROCESSES,
  PAGE_APP_DESKTOP_MAX_WINDOWS,
  PAGE_APP_DESKTOP_MENU_MAX_DEPTH,
  PAGE_APP_DESKTOP_MENU_MAX_ITEMS,
  PAGE_APP_DESKTOP_METHOD_PERMISSIONS,
  PAGE_APP_DESKTOP_NODE_API_CALL_CHANNEL,
  PAGE_APP_DESKTOP_NODE_API_EVENT_CHANNEL,
  PAGE_APP_DESKTOP_PERMISSIONS,
  PAGE_APP_DESKTOP_PERMISSIONS_DECLARE_CHANNEL,
  PAGE_APP_DESKTOP_SHORTCUT_DIR_ENV,
  PAGE_APP_DESKTOP_TIER2_PERMISSIONS,
  PAGE_APP_DESKTOP_TRAY_MENU_COLLAPSE_THRESHOLD,
  sanitizeDesktopScreenDisplay,
} from "@moss/contracts";

export {
  getPageAppDesktopMethodTier,
  PAGE_APP_DESKTOP_AUMID_PREFIX,
  PAGE_APP_DESKTOP_CONFIRM_COOLDOWN_MS,
  PAGE_APP_DESKTOP_DIALOG_PARTITION,
  PAGE_APP_DESKTOP_DRAG_REGIONS_CHANNEL,
  PAGE_APP_DESKTOP_EXEC_MAX_BUFFER_BYTES,
  PAGE_APP_DESKTOP_FS_MAX_READ_BYTES,
  PAGE_APP_DESKTOP_INSTALL_ID_PATTERN,
  PAGE_APP_DESKTOP_LAUNCH_ARG_PREFIX,
  PAGE_APP_DESKTOP_MAX_DRAG_REGIONS,
  PAGE_APP_DESKTOP_MAX_PROCESSES,
  PAGE_APP_DESKTOP_MAX_WINDOWS,
  PAGE_APP_DESKTOP_MENU_MAX_DEPTH,
  PAGE_APP_DESKTOP_MENU_MAX_ITEMS,
  PAGE_APP_DESKTOP_METHOD_PERMISSIONS,
  PAGE_APP_DESKTOP_NODE_API_CALL_CHANNEL,
  PAGE_APP_DESKTOP_NODE_API_EVENT_CHANNEL,
  PAGE_APP_DESKTOP_PERMISSIONS,
  PAGE_APP_DESKTOP_PERMISSIONS_DECLARE_CHANNEL,
  PAGE_APP_DESKTOP_SHORTCUT_DIR_ENV,
  PAGE_APP_DESKTOP_TIER2_PERMISSIONS,
  PAGE_APP_DESKTOP_TRAY_MENU_COLLAPSE_THRESHOLD,
  sanitizeDesktopScreenDisplay,
};

export type { PageAppDesktopSourceTrust };
export type DesktopPageAppPermission = PageAppDesktopPermission;
export type DesktopPageAppTier2Permission = PageAppDesktopTier2Permission;
export type DesktopPageAppPermissionTier = PageAppDesktopPermissionTier;
export type DesktopPageAppPermissionAnswer = "granted" | "denied" | "prompt" | "unavailable";
export type DesktopPageAppStoredAnswer = "granted" | "denied";
export type DesktopPageAppTrustKind = PageAppDesktopSourceTrust;
export type {
  DesktopPageAppInstallPlace,
  DesktopPageAppInstallState,
  DesktopPageAppPolicyState,
  DesktopPageAppScreenDisplay,
  DesktopPageAppWindowGetOptionsResult,
  DesktopPageAppWindowOptions,
  DesktopPageAppWindowPlaceInput,
  DesktopPageAppWindowSetOptionsResult,
};

export interface InstalledDesktopPageApp extends ContractInstalledDesktopPageApp {
  readonly accountId?: string;
  readonly orgId?: string;
  readonly sourceUrl?: string;
  readonly sourceTrust?: DesktopPageAppTrustKind;
}

export interface StoredDesktopPageAppPermission {
  readonly answer: DesktopPageAppStoredAnswer;
  readonly revision: number;
  readonly contentHash: string | null;
  readonly coversTier2?: boolean;
  readonly runsOn?: readonly string[];
  readonly held?: boolean;
  readonly updatedAt: string;
}

export interface DesktopPageAppBounds {
  readonly x?: number;
  readonly y?: number;
  readonly width: number;
  readonly height: number;
}

export interface StoredDesktopPageAppWindowStyle extends DesktopPageAppWindowOptions {
  readonly bounds?: DesktopPageAppBounds;
  readonly trafficLightPosition?: { readonly x: number; readonly y: number } | undefined;
  readonly visualEffectState?: "followWindow" | "active" | "inactive" | undefined;
  readonly visibleOnAllWorkspaces?: boolean;
  readonly ignoreMouseEvents?: boolean;
  readonly updatedAt: string;
}

export const PAGE_APP_ICON_SLOT_COUNT = 8;
export const PAGE_APP_TIER2_PERMISSIONS = PAGE_APP_DESKTOP_TIER2_PERMISSIONS;
export const PAGE_APP_MAX_STANDALONE_WINDOWS = PAGE_APP_DESKTOP_MAX_WINDOWS;
export const PAGE_APP_DIALOG_COOLDOWN_MS = PAGE_APP_DESKTOP_CONFIRM_COOLDOWN_MS;
export const PAGE_APP_MAX_CHILD_PROCESSES = PAGE_APP_DESKTOP_MAX_PROCESSES;
export const PAGE_APP_MAX_FS_READ_BYTES = PAGE_APP_DESKTOP_FS_MAX_READ_BYTES;
export const PAGE_APP_MAX_EXEC_BUFFER_BYTES = PAGE_APP_DESKTOP_EXEC_MAX_BUFFER_BYTES;
export const PAGE_APP_MAX_DRAG_REGIONS = PAGE_APP_DESKTOP_MAX_DRAG_REGIONS;
export const PAGE_APP_MAX_MENU_DEPTH = PAGE_APP_DESKTOP_MENU_MAX_DEPTH;
export const PAGE_APP_MAX_MENU_ITEMS = PAGE_APP_DESKTOP_MENU_MAX_ITEMS;
export const PAGE_APP_TRAY_FOLD_THRESHOLD = PAGE_APP_DESKTOP_TRAY_MENU_COLLAPSE_THRESHOLD;
export const PAGE_APP_AUMID_PREFIX = PAGE_APP_DESKTOP_AUMID_PREFIX;
export const PAGE_APP_LAUNCH_ARG_PREFIX = PAGE_APP_DESKTOP_LAUNCH_ARG_PREFIX;
export const PAGE_APP_INSTALL_ID_RE = PAGE_APP_DESKTOP_INSTALL_ID_PATTERN;
