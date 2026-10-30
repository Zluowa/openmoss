// Server-only authority for the canonical Windows managed Codex home.
// Neither a reserved account name nor a copied marker grants this capability.
import { constants } from "node:fs";
import path from "node:path";

import type { ServerSettings } from "@synara/contracts";
import { codexAccountInstanceId } from "@synara/shared/providerInstances";

import {
  resolveCodexPathIdentityIo,
  codexDirectoriesReferenceSameUnredirectedLocationIo,
} from "../codexPathIdentity.ts";
import {
  codexAuthFs,
  codexAuthIo,
  runCodexAuthIoSync,
  runCodexAuthIoAsync,
  type CodexAuthIo,
} from "../codexAuthIo.ts";

export const MOSS_MANAGED_HOME_OWNERSHIP_MARKER = ".moss-managed-home";
export const MOSS_MANAGED_HOME_PROVISIONING_STATE = "preparing-home-v1";
const LEGACY_MARKER = "moss-managed-codex-home-v1\n";
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function buildMossManagedHomeOwnershipMarker(ownershipNonce: string): string {
  if (!UUID_V4_PATTERN.test(ownershipNonce)) {
    throw new Error("The managed Moss home ownership nonce is invalid.");
  }
  return `moss-managed-codex-home-v2:${ownershipNonce}\n`;
}

export interface VerifiedMossManagedCodexReservation {
  readonly ownershipNonce: string | undefined;
  readonly provisioning: boolean;
}

/** Shared with provisioning/cleanup: preserve the existing v1 migration contract. */
export function verifiedMossManagedCodexReservation(
  settings: ServerSettings,
  managedHomePath: string,
): VerifiedMossManagedCodexReservation | undefined {
  return runCodexAuthIoSync(verifiedMossManagedCodexReservationIo(settings, managedHomePath));
}

function* verifiedMossManagedCodexReservationIo(
  settings: ServerSettings,
  managedHomePath: string,
): CodexAuthIo<VerifiedMossManagedCodexReservation | undefined> {
  const canonicalHome = path.resolve(managedHomePath);
  const instance = settings.providerInstances[codexAccountInstanceId("moss")];
  const config: Readonly<Record<string, unknown>> =
    typeof instance?.config === "object" &&
    instance.config !== null &&
    !Array.isArray(instance.config)
      ? (instance.config as Readonly<Record<string, unknown>>)
      : {};
  const account = settings.providers.codex.accounts.find((candidate) => candidate.id === "moss");
  const hasShadow = (value: unknown) =>
    value !== undefined && (typeof value !== "string" || value.trim().length > 0);
  if (
    instance?.driver !== "codex" ||
    config.managed !== true ||
    config.accountId !== "moss" ||
    typeof config.homePath !== "string" ||
    !(yield* codexDirectoriesReferenceSameUnredirectedLocationIo(config.homePath, canonicalHome)) ||
    !account ||
    !(yield* codexDirectoriesReferenceSameUnredirectedLocationIo(
      account.homePath,
      canonicalHome,
    )) ||
    hasShadow(config.shadowHomePath) ||
    hasShadow(account.shadowHomePath) ||
    (instance.environment ?? []).some((entry) => entry.name.trim().toUpperCase() === "MOSS_HOME")
  )
    return undefined;
  const nonce = config.homeOwnershipNonce;
  const provisioning = config.homeProvisioningState;
  if (nonce !== undefined && !UUID_V4_PATTERN.test(String(nonce))) return undefined;
  if (
    provisioning !== undefined &&
    (provisioning !== MOSS_MANAGED_HOME_PROVISIONING_STATE ||
      typeof nonce !== "string" ||
      instance.enabled !== false ||
      (instance.environment?.length ?? 0) !== 0)
  )
    return undefined;
  return {
    ownershipNonce: typeof nonce === "string" ? nonce : undefined,
    provisioning: provisioning === MOSS_MANAGED_HOME_PROVISIONING_STATE,
  };
}

export interface ManagedCodexHomeAuthority {
  readonly homePath: string;
  readonly ownershipMarker: string;
  /** Revalidate the current server settings as well as the bound filesystem. */
  readonly assertCurrent: () => Promise<void>;
}

interface AuthorityBinding {
  readonly assertCurrent: () => CodexAuthIo<void>;
  readonly home: { readonly path: string; readonly dev: bigint; readonly ino: bigint };
}
// The public input schemas cannot synthesize this process-local capability.
const issuedAuthorities = new WeakMap<ManagedCodexHomeAuthority, AuthorityBinding>();

export function assertManagedCodexHomeAuthorityCurrentSync(
  authority: ManagedCodexHomeAuthority,
  sourceHomePath?: string,
): void {
  runCodexAuthIoSync(assertManagedCodexHomeAuthorityCurrentIo(authority, sourceHomePath));
}

/** Keep asynchronous fingerprint readers asynchronous as well. */
export function* assertManagedCodexHomeAuthorityCurrentIo(
  authority: ManagedCodexHomeAuthority,
  sourceHomePath?: string,
): CodexAuthIo<void> {
  const binding = issuedAuthorities.get(authority);
  if (!binding) throw new Error("The managed Codex home authority was not issued by the server.");
  yield* binding.assertCurrent();
  if (sourceHomePath !== undefined) {
    const source = yield* realDirectory(sourceHomePath);
    if (
      !(yield* codexDirectoriesReferenceSameUnredirectedLocationIo(
        sourceHomePath,
        binding.home.path,
      )) ||
      source.dev !== binding.home.dev ||
      source.ino !== binding.home.ino
    ) {
      throw new Error("The managed Codex source does not match its server-issued authority.");
    }
  }
}

function* realDirectory(
  directory: string,
): CodexAuthIo<{ path: string; dev: bigint; ino: bigint }> {
  const stat = yield* codexAuthFs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("The managed Codex home and state directory must be real directories.");
  }
  return { path: yield* codexAuthFs.realpath(directory), dev: stat.dev, ino: stat.ino };
}

function* readMarker(markerPath: string): CodexAuthIo<string> {
  const before = yield* codexAuthFs.lstat(markerPath);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 256n) {
    throw new Error("The managed Moss home has no valid ownership marker.");
  }
  const handle = yield* codexAuthFs.open(
    markerPath,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)),
  );
  try {
    const opened = yield* handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeNs !== before.mtimeNs
    ) {
      throw new Error("The managed Moss ownership marker changed while opening.");
    }
    const bytes = yield* handle.readBounded(256);
    const after = yield* handle.stat();
    const current = yield* codexAuthFs.lstat(markerPath);
    if (
      BigInt(bytes.length) !== opened.size ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      current.isSymbolicLink() ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino ||
      current.size !== opened.size ||
      current.mtimeNs !== opened.mtimeNs
    ) {
      throw new Error("The managed Moss ownership marker changed while reading.");
    }
    return bytes.toString("utf8");
  } finally {
    yield* handle.close();
  }
}

/** Only call from server services with the real fixed stateDir/settings reader. */
export async function readManagedCodexHomeAuthority(input: {
  readonly stateDir: string;
  readonly readSettings: () => Promise<ServerSettings>;
  /** Server settings are backed by an in-memory Ref; never a client snapshot. */
  readonly readSettingsSync: () => ServerSettings;
  readonly input: {
    readonly homePath?: string | undefined;
    readonly shadowHomePath?: string | undefined;
    readonly accountId?: string | undefined;
    readonly env?: NodeJS.ProcessEnv | undefined;
  };
  readonly platform?: NodeJS.Platform;
}): Promise<ManagedCodexHomeAuthority | undefined> {
  if ((input.platform ?? process.platform) !== "win32" || input.input.accountId !== "moss") {
    return undefined;
  }
  const expectedHome = path.join(path.resolve(input.stateDir), "moss-codex-home");
  if (
    !input.input.homePath ||
    input.input.shadowHomePath ||
    !(await runCodexAuthIoAsync(
      codexDirectoriesReferenceSameUnredirectedLocationIo(input.input.homePath, expectedHome),
    ))
  ) {
    throw new Error("The managed Codex launch does not use the server-owned home.");
  }
  const ambientAliases = Object.entries(input.input.env ?? process.env)
    .filter(([name]) => name.toUpperCase() === "CODEX_HOME")
    .map(([, value]) => value?.trim());
  for (const ambientHome of ambientAliases) {
    if (
      ambientHome &&
      (await runCodexAuthIoAsync(resolveCodexPathIdentityIo(ambientHome))) ===
        (await runCodexAuthIoAsync(resolveCodexPathIdentityIo(expectedHome)))
    ) {
      throw new Error("The managed Codex home must be independent of ambient CODEX_HOME.");
    }
  }
  const checkReservation = function* (
    settings: ServerSettings,
  ): CodexAuthIo<VerifiedMossManagedCodexReservation> {
    const reservation = yield* verifiedMossManagedCodexReservationIo(settings, expectedHome);
    if (
      !reservation ||
      reservation.provisioning ||
      settings.providerInstances[codexAccountInstanceId("moss")]?.enabled === false
    ) {
      throw new Error("The managed Codex home has no active server reservation.");
    }
    return reservation;
  };
  const reservation = await runCodexAuthIoAsync(checkReservation(await input.readSettings()));
  const ownershipMarker =
    reservation.ownershipNonce === undefined
      ? LEGACY_MARKER
      : buildMossManagedHomeOwnershipMarker(reservation.ownershipNonce);
  const state = await runCodexAuthIoAsync(realDirectory(input.stateDir));
  const home = await runCodexAuthIoAsync(realDirectory(expectedHome));
  if (path.dirname(home.path) !== state.path || path.basename(home.path) !== "moss-codex-home") {
    throw new Error("The managed Codex home escapes the server state directory.");
  }
  const assertFilesystem = function* (): CodexAuthIo<void> {
    const currentState = yield* realDirectory(input.stateDir);
    const currentHome = yield* realDirectory(expectedHome);
    if (
      currentState.path !== state.path ||
      currentState.dev !== state.dev ||
      currentState.ino !== state.ino ||
      currentHome.path !== home.path ||
      currentHome.dev !== home.dev ||
      currentHome.ino !== home.ino ||
      (yield* readMarker(path.join(expectedHome, MOSS_MANAGED_HOME_OWNERSHIP_MARKER))) !==
        ownershipMarker
    ) {
      throw new Error("The managed Codex home ownership changed.");
    }
  };
  await runCodexAuthIoAsync(assertFilesystem());
  const assertCurrent = function* (): CodexAuthIo<void> {
    const current = yield* checkReservation(
      yield* codexAuthIo(input.readSettingsSync, input.readSettings),
    );
    if (current.ownershipNonce !== reservation.ownershipNonce) {
      throw new Error("The managed Codex home reservation changed.");
    }
    yield* assertFilesystem();
  };
  const authority: ManagedCodexHomeAuthority = Object.freeze({
    homePath: home.path,
    ownershipMarker,
    assertCurrent: () => runCodexAuthIoAsync(assertCurrent()),
  });
  issuedAuthorities.set(authority, { assertCurrent, home });
  return authority;
}
