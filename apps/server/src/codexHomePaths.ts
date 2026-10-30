// FILE: codexHomePaths.ts
// Purpose: Pure helpers that mirror how codexAppServerManager.ts decides which
//          CODEX_HOME directory the codex app-server child process runs against.
//          Centralizing this lets consumers outside the manager (the local image
//          allowlist, image-path predictions, etc.) stay in sync with the actual
//          runtime so they don't 404 paths Codex legitimately wrote.
// Layer: Server utility (no IO; safe to import from anywhere)
// Exports: overlay constants, base/overlay home resolvers, write-home + allowlist helpers.

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

import { expandProviderAccountHomePath } from "./providerAccountHomePath.ts";

export const MOSS_CODEX_HOME_OVERLAY_DIR = "codex-home-overlay";
export const MOSS_CODEX_HOME_ACCOUNT_OVERLAYS_DIR = "accounts";

export interface CodexHomePathsInput {
  readonly env?: NodeJS.ProcessEnv;
  readonly homePath?: string;
  readonly shadowHomePath?: string;
  readonly accountId?: string;
  readonly accountSourceHomeIsDedicated?: boolean;
  readonly platform?: NodeJS.Platform;
}

/** Path prediction only. Runtime access still requires server-proven ownership. */
export function usesCanonicalMossManagedCodexHome(input: CodexHomePathsInput = {}): boolean {
  if (
    (input.platform ?? process.platform) !== "win32" ||
    input.accountId?.trim() !== "moss" ||
    !input.homePath?.trim() ||
    input.shadowHomePath?.trim()
  ) {
    return false;
  }
  const env = input.env ?? process.env;
  return (
    path.resolve(resolveBaseCodexHomePath(env, input.homePath)) !==
    path.resolve(resolveBaseCodexHomePath(env))
  );
}

export function resolveBaseCodexHomePath(
  env: NodeJS.ProcessEnv,
  explicitHomePath?: string,
): string {
  return expandProviderAccountHomePath(
    explicitHomePath?.trim() || env.CODEX_HOME?.trim() || path.join(homedir(), ".codex"),
  );
}

export function resolveMossCodexHomeOverlayPath(
  env: NodeJS.ProcessEnv,
  sourceHomePath: string,
  accountSegment?: string,
): string {
  const runtimeHome = env.MOSS_HOME?.trim();
  const overlayRoot = runtimeHome || path.join(path.dirname(sourceHomePath), ".moss", "runtime");
  const overlayHome = path.join(overlayRoot, MOSS_CODEX_HOME_OVERLAY_DIR);
  return accountSegment
    ? path.join(overlayHome, MOSS_CODEX_HOME_ACCOUNT_OVERLAYS_DIR, accountSegment)
    : overlayHome;
}

export function resolveCodexHomeOverlayAccountSegment(
  input: Pick<
    CodexHomePathsInput,
    "accountId" | "homePath" | "shadowHomePath" | "accountSourceHomeIsDedicated"
  >,
): string | undefined {
  const accountId = input.accountId?.trim();
  const shadowHomePath = input.shadowHomePath?.trim();
  if (
    (!accountId || accountId === "default") &&
    !shadowHomePath &&
    input.accountSourceHomeIsDedicated !== true
  ) {
    return undefined;
  }

  const label =
    (accountId || (shadowHomePath ? "shadow" : "default"))
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .slice(0, 32) || "codex";
  const digest = createHash("sha256")
    .update(accountId ?? "")
    .update("\0")
    .update(input.homePath ?? "")
    .update("\0")
    .update(shadowHomePath ?? "")
    .digest("hex")
    .slice(0, 12);
  return `${label}-${digest}`;
}

/**
 * Returns the home directory that the codex app-server child process actually
 * writes under. Moss keeps its generated config isolated from the user's
 * source Codex home while linking shared state such as authentication.
 */
export function resolveActiveCodexHomeWritePath(input: CodexHomePathsInput = {}): string {
  if (usesCanonicalMossManagedCodexHome(input)) {
    return resolveBaseCodexHomePath(input.env ?? process.env, input.homePath);
  }
  return resolveCodexHomeOverlayWritePath(input);
}

/** Legacy overlay location, including after managed runtimes move to their source. */
export function resolveCodexHomeOverlayWritePath(input: CodexHomePathsInput = {}): string {
  const env = input.env ?? process.env;
  const source = resolveBaseCodexHomePath(env, input.homePath);
  const defaultSource = resolveBaseCodexHomePath(env);
  const defaultOverlay = resolveMossCodexHomeOverlayPath(env, source);
  if (path.resolve(source) === path.resolve(defaultOverlay)) {
    return source;
  }
  const accountSourceHomeIsDedicated =
    input.accountSourceHomeIsDedicated ??
    Boolean(input.homePath?.trim() && path.resolve(source) !== path.resolve(defaultSource));
  const overlay = resolveMossCodexHomeOverlayPath(
    env,
    source,
    resolveCodexHomeOverlayAccountSegment({
      homePath: source,
      accountSourceHomeIsDedicated,
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.shadowHomePath
        ? { shadowHomePath: resolveBaseCodexHomePath(env, input.shadowHomePath) }
        : {}),
    }),
  );
  return path.resolve(source) === path.resolve(overlay) ? source : overlay;
}

/**
 * Returns every Codex home directory we should treat as legitimate when
 * allowlisting locally-generated image files: the source home and the overlay
 * home if they are distinct. Callers pre-`realpath`-resolve these as needed.
 *
 * The overlay candidate remains included so generated images from earlier
 * sessions stay serveable until they are removed.
 */
export function resolveCodexHomeAllowlistCandidates(
  input: CodexHomePathsInput = {},
): readonly string[] {
  const env = input.env ?? process.env;
  const source = resolveBaseCodexHomePath(env, input.homePath);
  const shadow = input.shadowHomePath
    ? resolveBaseCodexHomePath(env, input.shadowHomePath)
    : undefined;
  const defaultSource = resolveBaseCodexHomePath(env);
  const defaultOverlay = resolveMossCodexHomeOverlayPath(env, source);
  if (path.resolve(source) === path.resolve(defaultOverlay)) {
    return [source];
  }
  const accountSourceHomeIsDedicated =
    input.accountSourceHomeIsDedicated ??
    Boolean(input.homePath?.trim() && path.resolve(source) !== path.resolve(defaultSource));
  const accountSegment = resolveCodexHomeOverlayAccountSegment({
    homePath: source,
    accountSourceHomeIsDedicated,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(shadow ? { shadowHomePath: shadow } : {}),
  });
  const overlay = resolveMossCodexHomeOverlayPath(env, source);
  const accountOverlay = accountSegment
    ? resolveMossCodexHomeOverlayPath(env, source, accountSegment)
    : undefined;

  // Account-scoped instances must not inherit the default source/overlay roots.
  // Their legitimate history is limited to their account overlay plus an
  // explicitly dedicated direct home or shadow home.
  if (accountOverlay) {
    const hasDedicatedSource = !shadow && accountSourceHomeIsDedicated;
    const accountCandidates = [
      ...(hasDedicatedSource ? [source] : []),
      accountOverlay,
      ...(shadow ? [shadow] : []),
    ];
    return accountCandidates.filter(
      (candidate, index) =>
        accountCandidates.findIndex(
          (existing) => path.resolve(existing) === path.resolve(candidate),
        ) === index,
    );
  }
  const sourceResolved = path.resolve(source);
  const overlayResolved = path.resolve(overlay);
  const candidates = sourceResolved === overlayResolved ? [source] : [source, overlay];
  return candidates;
}

// Moss-era aliases preserved for account cleanup code.
