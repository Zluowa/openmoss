// FILE: mossAuthDeepLink.ts
// Purpose: Strictly validates Moss authentication callbacks and maps them to the renderer route.
// Layer: Desktop main-process utility
// Exports: callback parsing, argv extraction, and renderer URL construction helpers

import * as Path from "node:path";

import { MOSS_AUTH_PROTOCOL_REGISTRATION_DISABLED_ENV } from "@synara/shared/desktopIdentity";

const MOSS_AUTH_CALLBACK_SCHEME = "moss:";
const MOSS_AUTH_CALLBACK_HOST = "auth";
const MOSS_AUTH_CALLBACK_PATH = "/callback";
const MOSS_AUTH_CALLBACK_ROUTE = "/auth/callback";
const MOSS_AUTH_CALLBACK_CODE_MAX_LENGTH = 4096;
const MOSS_AUTH_CALLBACK_FLOW_ID_PATTERN = /^[A-Za-z0-9._~-]{32,512}$/u;
const MOSS_AUTH_CALLBACK_URL_MAX_LENGTH = 16_384;
const MOSS_AUTH_PROTOCOL_RELAY_ARGUMENT = "--moss-auth-callback-relay";
const ELECTRON_USER_DATA_ARGUMENT_PREFIX = "--user-data-dir=";

const containsAsciiControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
};

/**
 * Electron's development process may carry launcher ownership flags before the
 * real main script. Protocol registration on Windows must relaunch that script,
 * never a flag or a callback URL supplied by another process.
 */
export function resolveMossAuthProtocolClientEntryPoint(
  argv: ReadonlyArray<string>,
): string | null {
  for (const argument of argv.slice(1)) {
    if (
      argument.length === 0 ||
      argument !== argument.trim() ||
      argument.startsWith("-") ||
      argument.includes("://") ||
      containsAsciiControlCharacter(argument) ||
      !/\.(?:c|m)?js$/iu.test(argument)
    ) {
      continue;
    }
    return argument;
  }
  return null;
}

/**
 * Development protocol callbacks are short-lived relay processes. Pinning the
 * exact browser profile makes Electron's single-instance lock forward the
 * callback to the Dev window that initiated OAuth instead of opening a second
 * process against a default Moss profile.
 */
export function buildMossAuthProtocolClientArguments(
  argv: ReadonlyArray<string>,
  userDataPath: string,
): string[] | null {
  const entryPoint = resolveMossAuthProtocolClientEntryPoint(argv);
  const normalizedUserDataPath = userDataPath.trim();
  if (
    entryPoint === null ||
    normalizedUserDataPath.length === 0 ||
    containsAsciiControlCharacter(normalizedUserDataPath) ||
    !Path.isAbsolute(normalizedUserDataPath)
  ) {
    return null;
  }

  return [
    MOSS_AUTH_PROTOCOL_RELAY_ARGUMENT,
    `${ELECTRON_USER_DATA_ARGUMENT_PREFIX}${Path.resolve(normalizedUserDataPath)}`,
    Path.resolve(entryPoint),
  ];
}

/** A relay must never become a standalone app when the initiating Dev window is gone. */
export function isMossAuthProtocolRelayProcess(argv: ReadonlyArray<string>): boolean {
  return argv.slice(1).includes(MOSS_AUTH_PROTOCOL_RELAY_ARGUMENT);
}

/**
 * End-to-end runs can exercise the same callback parser without changing the
 * operating system's global owner for the moss:// scheme.
 */
export function shouldRegisterMossAuthCallbackProtocolClient(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return env[MOSS_AUTH_PROTOCOL_REGISTRATION_DISABLED_ENV] !== "1";
}

/**
 * Accept only the OAuth callback authority owned by Moss. Keeping this parser
 * independent of Electron makes every OS entry point share the same boundary.
 */
export function resolveMossAuthCallbackRoute(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MOSS_AUTH_CALLBACK_URL_MAX_LENGTH ||
    value !== value.trim()
  ) {
    return null;
  }
  if (containsAsciiControlCharacter(value) || value.includes("#")) {
    return null;
  }
  const rawAuthority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(value)?.[1];
  if (rawAuthority?.toLowerCase() !== MOSS_AUTH_CALLBACK_HOST) {
    return null;
  }

  let callbackUrl: URL;
  try {
    callbackUrl = new URL(value);
  } catch {
    return null;
  }

  if (
    callbackUrl.protocol !== MOSS_AUTH_CALLBACK_SCHEME ||
    callbackUrl.host !== MOSS_AUTH_CALLBACK_HOST ||
    callbackUrl.pathname !== MOSS_AUTH_CALLBACK_PATH ||
    callbackUrl.username.length > 0 ||
    callbackUrl.password.length > 0 ||
    callbackUrl.hash.length > 0
  ) {
    return null;
  }

  const queryEntries = [...callbackUrl.searchParams.entries()];
  const codeValues = callbackUrl.searchParams.getAll("code");
  const flowIdValues = callbackUrl.searchParams.getAll("flow_id");
  const isLegacyCallback =
    queryEntries.length === 1 && codeValues.length === 1 && flowIdValues.length === 0;
  const isGoogleCallback =
    queryEntries.length === 2 && codeValues.length === 1 && flowIdValues.length === 1;
  if (!isLegacyCallback && !isGoogleCallback) {
    return null;
  }
  const code = codeValues[0] ?? "";
  const flowId = flowIdValues[0] ?? null;
  if (
    code.trim().length === 0 ||
    code.length > MOSS_AUTH_CALLBACK_CODE_MAX_LENGTH ||
    containsAsciiControlCharacter(code)
  ) {
    return null;
  }
  if (
    flowId !== null &&
    (!MOSS_AUTH_CALLBACK_FLOW_ID_PATTERN.test(flowId) || containsAsciiControlCharacter(flowId))
  ) {
    return null;
  }

  const safeSearch = new URLSearchParams(flowId === null ? { code } : { code, flowId }).toString();
  return `${MOSS_AUTH_CALLBACK_ROUTE}?${safeSearch}`;
}

/** Resolve the first valid callback URL supplied by Electron in process argv. */
export function resolveMossAuthCallbackRouteFromArgv(argv: ReadonlyArray<string>): string | null {
  for (const argument of argv) {
    const route = resolveMossAuthCallbackRoute(argument);
    if (route) {
      return route;
    }
  }
  return null;
}

/** Build the hash-history URL used by the Electron renderer. */
export function buildMossAuthCallbackRendererUrl(appUrl: string, route: string): string {
  const routeQuery = route.startsWith(`${MOSS_AUTH_CALLBACK_ROUTE}?`)
    ? route.slice(MOSS_AUTH_CALLBACK_ROUTE.length + 1)
    : null;
  const routeEntries = routeQuery === null ? [] : [...new URLSearchParams(routeQuery).entries()];
  const code = routeEntries[0]?.[0] === "code" ? routeEntries[0][1] : null;
  const flowId = routeEntries[1]?.[0] === "flowId" ? routeEntries[1][1] : null;
  const hasExactParameters =
    code !== null && (routeEntries.length === 1 || (routeEntries.length === 2 && flowId !== null));
  const protocolUrl = new URL(
    `${MOSS_AUTH_CALLBACK_SCHEME}//${MOSS_AUTH_CALLBACK_HOST}${MOSS_AUTH_CALLBACK_PATH}`,
  );
  if (hasExactParameters && flowId !== null) {
    protocolUrl.searchParams.set("flow_id", flowId);
  }
  if (hasExactParameters && code !== null) {
    protocolUrl.searchParams.set("code", code);
  }
  const callbackRoute = hasExactParameters
    ? resolveMossAuthCallbackRoute(protocolUrl.toString())
    : null;
  if (callbackRoute !== route) {
    throw new Error("Invalid Moss authentication callback route.");
  }

  const rendererUrl = new URL(appUrl);
  rendererUrl.hash = route;
  return rendererUrl.toString();
}
