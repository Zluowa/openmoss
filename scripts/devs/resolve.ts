/**
 * Marks a developer report as being fixed or fixed, so the person who sent it sees it:
 *
 *   bun scripts/devs/resolve.ts <reportId> --fixed --pr <url> [--note <text>]
 *   bun scripts/devs/resolve.ts <reportId> --in-progress [--pr <url>] [--note <text>]
 *
 * The worker credential is read the way the local repair worker reads it (DPAPI, through
 * PowerShell) and never printed.
 */
import { execFile } from "node:child_process";

export const DEVS_QUEUE_URL = "https://moss-devs.inkcomicai.com";
const WORKER_TOKEN_FILE = "E:/DevEnvs/moss-synara/devs-local/worker-token.dpapi";
const REPORT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PULL_REQUEST = /^https:\/\/github\.com\/Zluowa\/moss-synara\/pull\/\d+$/;
const USAGE =
  "Usage: bun scripts/devs/resolve.ts <reportId> (--fixed --pr <url> | --in-progress [--pr <url>]) [--note <text>]";

export interface DevsResolveRequest {
  readonly reportId: string;
  readonly body: {
    readonly status: "in-progress" | "fixed";
    readonly pullRequestUrl?: string;
    readonly note?: string;
  };
}

/** Reads the command line; throws the usage with the first problem it finds. */
export function parseDevsResolveArgs(argv: readonly string[]): DevsResolveRequest {
  let reportId: string | undefined;
  let status: "in-progress" | "fixed" | undefined;
  let pullRequestUrl: string | undefined;
  let note: string | undefined;
  const fail = (problem: string): never => {
    throw new Error(`${problem}\n${USAGE}`);
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    const value = () => {
      const next = argv[++index];
      if (next === undefined || next.startsWith("--")) fail(`${argument} needs a value.`);
      return next as string;
    };
    if (argument === "--fixed" || argument === "--in-progress") {
      const next = argument === "--fixed" ? "fixed" : "in-progress";
      if (status && status !== next) fail("Choose --fixed or --in-progress, not both.");
      status = next;
    } else if (argument === "--pr") pullRequestUrl = value();
    else if (argument === "--note") note = value();
    else if (argument.startsWith("--")) fail(`Unknown option ${argument}.`);
    else if (reportId) fail(`Unexpected argument ${argument}.`);
    else reportId = argument;
  }
  if (!reportId || !REPORT_ID.test(reportId)) fail("Give the report ID (a UUID).");
  if (!status) fail("Choose --fixed or --in-progress.");
  if (pullRequestUrl !== undefined && !PULL_REQUEST.test(pullRequestUrl))
    fail("--pr must be a Zluowa/moss-synara pull request URL.");
  if (status === "fixed" && pullRequestUrl === undefined) fail("--fixed needs --pr <url>.");
  if (note !== undefined && (!note.trim() || note.length > 2_000))
    fail("--note must be 1 to 2000 characters.");
  return {
    reportId: reportId as string,
    body: {
      status: status as "in-progress" | "fixed",
      ...(pullRequestUrl ? { pullRequestUrl } : {}),
      ...(note ? { note: note.trim() } : {}),
    },
  };
}

/** The local worker's credential, decrypted for this user by DPAPI. */
export function readWorkerToken(): Promise<string> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$secure = ConvertTo-SecureString -String (Get-Content -LiteralPath $env:MOSS_DEVS_TOKEN_FILE -Raw).Trim()",
    "$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)",
    "try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }",
  ].join("; ");
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { env: { ...process.env, MOSS_DEVS_TOKEN_FILE: WORKER_TOKEN_FILE }, windowsHide: true },
      (error, stdout) => {
        const token = String(stdout).trim();
        if (error || token.length < 32)
          reject(new Error(`Could not read the worker credential from ${WORKER_TOKEN_FILE}.`));
        else resolve(token);
      },
    );
  });
}

async function main() {
  const request = parseDevsResolveArgs(process.argv.slice(2));
  const token = await readWorkerToken();
  const response = await fetch(`${DEVS_QUEUE_URL}/worker/${request.reportId}/resolve`, {
    method: "POST",
    redirect: "error",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(request.body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = (await response.text()).split(token).join("[redacted]");
  if (!response.ok) {
    console.error(`The queue refused the resolution (HTTP ${response.status}): ${text}`);
    process.exit(1);
  }
  console.log(text);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
