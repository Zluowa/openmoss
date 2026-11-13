// FILE: mossAccountComputers.ts
// Purpose: What a Moss account remembers about the computers signed in to it, so the
// phone app can find them after an account sign-in. Moss has no device directory of its
// own: each computer writes one small entry into its account's user metadata, and the
// phone proves it holds the same account by writing a one-time code there, together with
// the public key the computer seals the phone's session to.
// Layer: Shared pure logic (server writes, phone reads; no I/O here)
// Exports: metadata keys and limits, readMossAccountComputers, mossAccountComputersUpdate,
//   mossAccountComputersRemoval, mossPhoneLoginProof, readMossPhoneLoginProof

/** User-metadata key holding the computers signed in to the account. */
export const MOSS_COMPUTERS_METADATA_KEY = "moss_computers";
/** User-metadata key a phone writes a computer's one-time sign-in code into. */
export const MOSS_PHONE_LOGIN_METADATA_KEY = "moss_phone_login";

// User metadata rides in every access token, so the list stays small.
export const MOSS_COMPUTERS_MAX = 4;
export const MOSS_COMPUTER_ORIGINS_MAX = 4;
export const MOSS_COMPUTER_NAME_MAX = 40;
/**
 * A computer that has not checked in for this long is forgotten, so an entry a computer
 * could not remove (it was offline, or signed in to another account) does not linger.
 */
export const MOSS_COMPUTER_STALE_MS = 7 * 24 * 60 * 60 * 1000;
/** A computer re-writes an unchanged entry this often, to stay listed. */
export const MOSS_COMPUTER_REFRESH_MS = 24 * 60 * 60 * 1000;
/** How long a phone sign-in code is accepted after it was issued. */
export const MOSS_PHONE_LOGIN_TTL_MS = 2 * 60 * 1000;

export interface MossAccountComputer {
  /** Stable for one Moss installation. */
  readonly id: string;
  readonly name: string;
  /** `darwin`, `win32`, `linux`. */
  readonly platform: string;
  /** Where a phone may reach this computer, best first. Empty: it accepts no phones. */
  readonly origins: ReadonlyArray<string>;
  readonly version: string;
  /** Unix milliseconds of the computer's last check-in. */
  readonly updatedAt: number;
}

/** The stored form: short keys and whole seconds. */
interface StoredComputer {
  readonly i: string;
  readonly n: string;
  readonly p: string;
  readonly o: ReadonlyArray<string>;
  readonly v: string;
  readonly t: number;
}

type Metadata = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
};

/** `http(s)://host[:port]` with nothing after it, or null. */
export function normalizeMossComputerOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 200) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function normalizeOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const origins: string[] = [];
  for (const candidate of value) {
    const origin = normalizeMossComputerOrigin(candidate);
    if (origin && !origins.includes(origin)) origins.push(origin);
    if (origins.length === MOSS_COMPUTER_ORIGINS_MAX) break;
  }
  return origins;
}

function fromStored(value: unknown): MossAccountComputer | null {
  if (!isRecord(value)) return null;
  const id = text(value.i, 64);
  const name = text(value.n, MOSS_COMPUTER_NAME_MAX);
  if (!id || !name || typeof value.t !== "number" || !Number.isFinite(value.t)) return null;
  return {
    id,
    name,
    platform: text(value.p, 16) ?? "",
    origins: normalizeOrigins(value.o),
    version: text(value.v, 32) ?? "",
    updatedAt: value.t * 1000,
  };
}

const toStored = (computer: MossAccountComputer): StoredComputer => ({
  i: computer.id,
  n: computer.name,
  p: computer.platform,
  o: computer.origins,
  v: computer.version,
  t: Math.floor(computer.updatedAt / 1000),
});

/** The computers an account lists that checked in recently, newest first. */
export function readMossAccountComputers(
  userMetadata: Metadata,
  now: number,
): ReadonlyArray<MossAccountComputer> {
  const stored = userMetadata[MOSS_COMPUTERS_METADATA_KEY];
  if (!Array.isArray(stored)) return [];
  const seen = new Set<string>();
  const computers: MossAccountComputer[] = [];
  for (const entry of stored) {
    const computer = fromStored(entry);
    if (!computer || seen.has(computer.id)) continue;
    if (now - computer.updatedAt > MOSS_COMPUTER_STALE_MS) continue;
    seen.add(computer.id);
    computers.push(computer);
  }
  return computers.sort((left, right) => right.updatedAt - left.updatedAt);
}

/** What a computer says about itself; the check-in time is added when it is written. */
export type MossAccountComputerSelf = Omit<MossAccountComputer, "updatedAt">;

export function normalizeMossAccountComputerSelf(
  self: MossAccountComputerSelf,
): MossAccountComputerSelf {
  return {
    id: self.id.trim().slice(0, 64),
    name: self.name.trim().slice(0, MOSS_COMPUTER_NAME_MAX) || "Moss",
    platform: self.platform.trim().slice(0, 16),
    origins: normalizeOrigins(self.origins),
    version: self.version.trim().slice(0, 32),
  };
}

const sameSelf = (listed: MossAccountComputer, self: MossAccountComputerSelf): boolean =>
  listed.name === self.name &&
  listed.platform === self.platform &&
  listed.version === self.version &&
  listed.origins.length === self.origins.length &&
  listed.origins.every((origin, index) => origin === self.origins[index]);

/**
 * The metadata update that lists `self`, or null when the account already says the same
 * and the entry is fresh. Stale and malformed entries are dropped along the way, and the
 * oldest computers make room once the list is full.
 */
export function mossAccountComputersUpdate(
  userMetadata: Metadata,
  selfInput: MossAccountComputerSelf,
  now: number,
): Readonly<Record<string, unknown>> | null {
  const self = normalizeMossAccountComputerSelf(selfInput);
  const listed = readMossAccountComputers(userMetadata, now);
  const current = listed.find((computer) => computer.id === self.id);
  const stored = userMetadata[MOSS_COMPUTERS_METADATA_KEY];
  const tidy = Array.isArray(stored) && stored.length === listed.length;
  if (
    current &&
    tidy &&
    sameSelf(current, self) &&
    now - current.updatedAt < MOSS_COMPUTER_REFRESH_MS
  ) {
    return null;
  }
  const others = listed
    .filter((computer) => computer.id !== self.id)
    .slice(0, MOSS_COMPUTERS_MAX - 1);
  return {
    [MOSS_COMPUTERS_METADATA_KEY]: [{ ...self, updatedAt: now }, ...others].map(toStored),
  };
}

/** The metadata update that stops listing a computer, or null when it is not listed. */
export function mossAccountComputersRemoval(
  userMetadata: Metadata,
  id: string,
  now: number,
): Readonly<Record<string, unknown>> | null {
  const stored = userMetadata[MOSS_COMPUTERS_METADATA_KEY];
  if (!Array.isArray(stored)) return null;
  const listed = readMossAccountComputers(userMetadata, now);
  const remaining = listed.filter((computer) => computer.id !== id);
  if (remaining.length === stored.length) return null;
  return {
    [MOSS_COMPUTERS_METADATA_KEY]: remaining.length > 0 ? remaining.map(toStored) : null,
  };
}

/** A raw X25519 public key: 32 bytes, base64url without padding. */
const PHONE_PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/** What a phone wrote to prove its account to one computer. */
export interface MossPhoneLoginProof {
  /** The computer's one-time challenge code, echoed through the account service. */
  readonly code: string;
  /** The phone's fresh X25519 public key for this attempt (base64url, 32 bytes). */
  readonly phonePublicKey: string;
}

/**
 * The metadata update a phone makes to prove its account to one computer. The computer
 * reads both values back with its own session, so a device that relays the computer's
 * address can neither write them nor swap the key.
 */
export function mossPhoneLoginProof(
  proof: MossPhoneLoginProof,
  now: number,
): Readonly<Record<string, unknown>> {
  return {
    [MOSS_PHONE_LOGIN_METADATA_KEY]: {
      c: proof.code,
      k: proof.phonePublicKey,
      t: Math.floor(now / 1000),
    },
  };
}

/** The metadata update that removes a used proof. */
export const MOSS_PHONE_LOGIN_PROOF_CLEARED: Readonly<Record<string, unknown>> = {
  [MOSS_PHONE_LOGIN_METADATA_KEY]: null,
};

/** The proof an account currently carries, or null when none is fresh and well formed. */
export function readMossPhoneLoginProof(
  userMetadata: Metadata,
  now: number,
): MossPhoneLoginProof | null {
  const stored = userMetadata[MOSS_PHONE_LOGIN_METADATA_KEY];
  if (!isRecord(stored)) return null;
  const code = text(stored.c, 128);
  const phonePublicKey = typeof stored.k === "string" ? stored.k : "";
  if (!code || !PHONE_PUBLIC_KEY_PATTERN.test(phonePublicKey)) return null;
  if (typeof stored.t !== "number" || !Number.isFinite(stored.t)) return null;
  if (Math.abs(now - stored.t * 1000) > MOSS_PHONE_LOGIN_TTL_MS + 60_000) return null;
  return { code, phonePublicKey };
}
