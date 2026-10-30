// FILE: pluginLibraryRouteModel.ts
// Purpose: Owns the canonical Codex Skills & Apps route grammar independently of React.
// Layer: Web routing model
// Exports: route state parsing and path construction helpers

export type PluginLibraryMode = "browse" | "manage";

export interface PluginLibraryRouteState {
  readonly mode: PluginLibraryMode;
  readonly pluginId: string | null;
  readonly legacy?: true;
  readonly settings?: true;
}

export type PluginDetailRouteViewState = "browse" | "loading" | "error" | "not-found" | "detail";

export function resolvePluginDetailRouteViewState(input: {
  readonly pluginId: string | null;
  readonly isLoading: boolean;
  readonly error: unknown;
  readonly found: boolean;
}): PluginDetailRouteViewState {
  if (input.pluginId === null) return "browse";
  if (input.found) return "detail";
  if (input.isLoading) return "loading";
  if (input.error !== null && input.error !== undefined) return "error";
  return "not-found";
}

function decodePluginId(value: string): string | null {
  if (value.length === 0 || value.includes("/") || value.includes("?") || value.includes("#")) {
    return null;
  }
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 &&
      decoded.length <= 1_024 &&
      decoded !== "." &&
      decoded !== ".." &&
      decoded.trim() === decoded &&
      !/[/\u0000-\u001f\u007f-\u009f]/u.test(decoded) &&
      encodeURIComponent(decoded) === value
      ? decoded
      : null;
  } catch {
    return null;
  }
}

export function buildPluginLibraryPath(input: {
  readonly mode: PluginLibraryMode;
  readonly pluginId?: string | null;
}): string {
  const root = input.mode === "manage" ? "/skills/manage" : "/skills";
  const pluginId = input.pluginId?.trim();
  return pluginId ? `${root}/plugins/${encodeURIComponent(pluginId)}` : root;
}

export function resolvePluginLibraryRoute(pathname: string): PluginLibraryRouteState | null {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (normalized === "/plugins") {
    return { mode: "browse", pluginId: null, legacy: true };
  }
  if (normalized === "/skills") {
    return { mode: "browse", pluginId: null };
  }
  if (normalized === "/skills/manage") {
    return { mode: "manage", pluginId: null };
  }
  if (normalized === "/settings/plugins-settings") {
    return { mode: "manage", pluginId: null, settings: true };
  }

  const manageMatch = normalized.match(/^\/skills\/manage\/plugins\/([^/]+)$/);
  if (manageMatch?.[1]) {
    const pluginId = decodePluginId(manageMatch[1]);
    return pluginId ? { mode: "manage", pluginId } : null;
  }

  const browseMatch = normalized.match(/^\/skills\/plugins\/([^/]+)$/);
  if (browseMatch?.[1]) {
    const pluginId = decodePluginId(browseMatch[1]);
    return pluginId ? { mode: "browse", pluginId } : null;
  }

  return null;
}

export function isCanonicalPluginLibraryPath(pathname: string): boolean {
  if (pathname === "/settings/plugins-settings") return true;
  const route = resolvePluginLibraryRoute(pathname);
  if (!route) return false;
  if (route.legacy) return false;
  return buildPluginLibraryPath({ mode: route.mode, pluginId: route.pluginId }) === pathname;
}
