import { randomBytes } from "node:crypto";

const DEFAULT_APP_URL = "moss://app/index.html";
const DEFAULT_CDP_URL = "http://127.0.0.1:9230";
const DEFAULT_TIMEOUT_MS = 180_000;

function isLoopbackHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "");
  return new Set(["localhost", "127.0.0.1", "::1"]).has(host);
}

function readPositiveInteger(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("invalid numeric option");
  return parsed;
}

function cleanCdpUrl(value) {
  const parsed = new URL(value);
  if (
    !["http:", "https:", "ws:", "wss:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !isLoopbackHost(parsed.hostname)
  ) {
    throw new Error("CDP endpoint must be loopback-only");
  }
  return parsed.toString().replace(/\/$/, "");
}

function cleanAppUrl(value) {
  const parsed = new URL(value);
  if (
    !["http:", "https:", "moss:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search
  ) {
    throw new Error("invalid app URL");
  }
  if (parsed.protocol === "moss:") {
    if (parsed.hostname !== "app" || parsed.port || parsed.pathname !== "/index.html") {
      throw new Error("packaged app URL must target Moss");
    }
  } else if (!isLoopbackHost(parsed.hostname)) {
    throw new Error("development app URL must be loopback-only");
  }
  parsed.hash = "";
  return parsed.toString();
}

function readKey(env) {
  const key = env.MOSS_KEY_E2E_KEY;
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("MOSS_KEY_E2E_KEY is required");
  }
  if (
    key.length < 8 ||
    key.length > 4_096 ||
    key.includes("\u0000") ||
    key.includes("\r") ||
    key.includes("\n")
  ) {
    throw new Error("MOSS_KEY_E2E_KEY is invalid");
  }
  return key;
}

export function parseMossKeyE2EOptions(argv, env) {
  const cli = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--expect-saved-key") {
      cli.expectSavedKey = true;
      continue;
    }
    if (arg === "--expect-removed-key") {
      cli.expectRemovedKey = true;
      continue;
    }
    if (arg === "--keep-key-on-success") {
      cli.keepKeyOnSuccess = true;
      continue;
    }
    if (arg === "--keep-key") {
      cli.keepKey = true;
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error("missing option value");
    const optionByFlag = {
      "--app-url": "appUrl",
      "--cdp-url": "cdpUrl",
      "--timeout-ms": "timeoutMs",
    };
    const key = optionByFlag[arg];
    if (!key) throw new Error("unknown option");
    cli[key] = next;
    index += 1;
  }

  const expectSavedKey =
    cli.expectSavedKey === true || /^(?:1|true)$/i.test(env.MOSS_KEY_E2E_EXPECT_SAVED_KEY ?? "");
  const expectRemovedKey =
    cli.expectRemovedKey === true ||
    /^(?:1|true)$/i.test(env.MOSS_KEY_E2E_EXPECT_REMOVED_KEY ?? "");
  if (expectSavedKey && expectRemovedKey) {
    throw new Error("saved-Key and removed-Key verification are mutually exclusive");
  }
  if ((expectSavedKey || expectRemovedKey) && env.MOSS_KEY_E2E_KEY !== undefined) {
    throw new Error("MOSS_KEY_E2E_KEY must be absent in verification-only modes");
  }
  const keepKey = cli.keepKey === true || /^(?:1|true)$/i.test(env.MOSS_KEY_E2E_KEEP_KEY ?? "");
  const keepKeyOnSuccess =
    cli.keepKeyOnSuccess === true ||
    /^(?:1|true)$/i.test(env.MOSS_KEY_E2E_KEEP_KEY_ON_SUCCESS ?? "");
  if ((expectSavedKey || expectRemovedKey) && (keepKey || keepKeyOnSuccess)) {
    throw new Error("verification-only modes reject Key retention flags");
  }

  return {
    help: false,
    appUrl: cleanAppUrl(cli.appUrl ?? env.MOSS_KEY_E2E_APP_URL ?? DEFAULT_APP_URL),
    cdpUrl: cleanCdpUrl(cli.cdpUrl ?? env.MOSS_KEY_E2E_CDP_URL ?? DEFAULT_CDP_URL),
    expectSavedKey,
    expectRemovedKey,
    keepKey,
    keepKeyOnSuccess,
    ...(expectSavedKey || expectRemovedKey ? {} : { key: readKey(env) }),
    timeoutMs: readPositiveInteger(
      cli.timeoutMs ?? env.MOSS_KEY_E2E_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
    ),
  };
}

export function removedMossKeyStateIsClean(state) {
  return state?.configured === false && state?.selected === false;
}

export function buildAppHashRoute(appUrl, route) {
  if (!route.startsWith("/")) throw new Error("route must start with a slash");
  const target = new URL(appUrl);
  target.search = "";
  target.hash = route;
  return target.toString();
}

export function appPageMatches(pageUrl, appUrl) {
  try {
    const page = new URL(pageUrl);
    const app = new URL(appUrl);
    return (
      page.protocol === app.protocol &&
      page.hostname === app.hostname &&
      page.port === app.port &&
      page.pathname === app.pathname
    );
  } catch {
    return false;
  }
}

export function createAcceptanceMarker() {
  return `MOSS_KEY_CHAT_OK_${randomBytes(8).toString("hex")}`;
}

export function acceptancePrompt(marker) {
  if (!/^MOSS_KEY_CHAT_OK_[a-f0-9]{16}$/u.test(marker)) {
    throw new Error("invalid acceptance marker");
  }
  return `Reply with exactly ${marker} and nothing else. Do not use tools.`;
}

export function chatSubmissionWasObserved(snapshot) {
  return (
    snapshot.markerVisible === true ||
    snapshot.turnRunning === true ||
    snapshot.editorPresent === false ||
    snapshot.editorMatchesPrompt === false ||
    new Set(["preparing-worktree", "sending"]).has(snapshot.sendState)
  );
}
