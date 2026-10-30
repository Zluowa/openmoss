import { access } from "node:fs/promises";
import { constants as FsConstants } from "node:fs";
import { spawn } from "node:child_process";
import type { CuaPerformActionArgs } from "@synara/shared/cuaDriverProtocol";

const CLICLICK_CANDIDATES = [
  "/opt/homebrew/bin/cliclick",
  "/usr/local/bin/cliclick",
  "cliclick",
] as const;

export type DarwinCuaDispatchResult = {
  readonly ok: boolean;
  readonly message?: string;
  readonly command?: readonly string[];
};

export type DarwinCuaInputDeps = {
  readonly platform?: NodeJS.Platform;
  readonly whichCliclick?: () => Promise<string | undefined>;
  readonly runCliclick?: (bin: string, args: readonly string[]) => Promise<DarwinCuaDispatchResult>;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeAction(action: string): string {
  return action
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function roundCoord(value: number): number {
  return Math.round(value);
}

/** Build cliclick argv for a structured Moss CUA action. Pure — safe for unit tests. */
export function buildCliclickArgs(input: CuaPerformActionArgs):
  | {
      readonly ok: true;
      readonly args: readonly string[];
      readonly kind: "hid" | "dry-run";
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly kind: "unsupported" | "invalid";
    } {
  const name = normalizeAction(input.action);
  if (name === "bounded_dry_run" || name === "boundeddryrun") {
    return { ok: true, args: [], kind: "dry-run" };
  }

  if (
    name === "click" ||
    name === "left_click" ||
    name === "leftclick" ||
    name === "double_click" ||
    name === "doubleclick" ||
    name === "right_click" ||
    name === "rightclick" ||
    name === "middle_click" ||
    name === "middleclick"
  ) {
    if (!isFiniteNumber(input.x) || !isFiniteNumber(input.y)) {
      return {
        ok: false,
        kind: "invalid",
        message: "Moss Computer Use click requires numeric x and y screen coordinates.",
      };
    }
    const x = roundCoord(input.x);
    const y = roundCoord(input.y);
    const clickCount =
      typeof input.clickCount === "number" && Number.isFinite(input.clickCount)
        ? Math.max(1, Math.min(3, Math.round(input.clickCount)))
        : name === "double_click" || name === "doubleclick"
          ? 2
          : 1;
    const button =
      input.button ??
      (name === "right_click" || name === "rightclick"
        ? "right"
        : name === "middle_click" || name === "middleclick"
          ? "middle"
          : "left");
    const prefix = button === "right" ? "rc" : button === "middle" ? "mc" : "c";
    // cliclick: c:x,y / rc:x,y ; double-click = two sequential clicks at same point.
    const args: string[] = [];
    for (let i = 0; i < clickCount; i += 1) {
      args.push(`${prefix}:${x},${y}`);
    }
    return { ok: true, args, kind: "hid" };
  }

  if (name === "move" || name === "mousemove" || name === "move_cursor") {
    if (!isFiniteNumber(input.x) || !isFiniteNumber(input.y)) {
      return {
        ok: false,
        kind: "invalid",
        message: "Moss Computer Use move requires numeric x and y screen coordinates.",
      };
    }
    return {
      ok: true,
      args: [`m:${roundCoord(input.x)},${roundCoord(input.y)}`],
      kind: "hid",
    };
  }

  if (name === "type" || name === "type_text" || name === "typetext") {
    const text = input.text;
    if (typeof text !== "string" || text.length === 0) {
      return {
        ok: false,
        kind: "invalid",
        message: "Moss Computer Use type requires a non-empty text string.",
      };
    }
    // cliclick t:text — quote-escape for shell-free argv (no shell).
    return { ok: true, args: [`t:${text}`], kind: "hid" };
  }

  if (name === "key" || name === "press_key" || name === "presskey" || name === "hotkey") {
    const key = input.key?.trim();
    if (!key) {
      return {
        ok: false,
        kind: "invalid",
        message: "Moss Computer Use key requires a key name.",
      };
    }
    // cliclick key press: kp:key
    return { ok: true, args: [`kp:${key}`], kind: "hid" };
  }

  return {
    ok: false,
    kind: "unsupported",
    message: `Moss Computer Use does not support action "${input.action}" on macOS yet.`,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, FsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCliclickBinary(
  candidates: readonly string[] = CLICLICK_CANDIDATES,
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (candidate.includes("/")) {
      if (await pathExists(candidate)) return candidate;
      continue;
    }
    // bare name: rely on PATH via `which`-like spawn check
    const found = await new Promise<string | undefined>((resolve) => {
      const child = spawn("which", [candidate], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      child.stdout?.on("data", (chunk: Buffer | string) => {
        out += chunk.toString();
      });
      child.on("error", () => resolve(undefined));
      child.on("close", (code) => {
        const line = out.trim().split("\n")[0]?.trim();
        resolve(code === 0 && line ? line : undefined);
      });
    });
    if (found) return found;
  }
  return undefined;
}

function runCliclickDefault(
  bin: string,
  args: readonly string[],
): Promise<DarwinCuaDispatchResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({
        ok: false,
        message: `Moss Computer Use could not start cliclick: ${error.message}`,
        command: [bin, ...args],
      });
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({
          ok: true,
          message: "Moss Computer Use dispatched OS input via cliclick.",
          command: [bin, ...args],
        });
        return;
      }
      resolve({
        ok: false,
        message: `Moss Computer Use cliclick failed (exit ${code ?? "unknown"})${
          stderr.trim() ? `: ${stderr.trim()}` : "."
        }`,
        command: [bin, ...args],
      });
    });
  });
}

/**
 * Dispatch a Moss CUA action on Darwin using cliclick when available.
 * Non-Darwin callers should not use this path; the host keeps Linux coming-soon.
 */
export async function dispatchDarwinCuaInput(
  input: CuaPerformActionArgs,
  deps: DarwinCuaInputDeps = {},
): Promise<DarwinCuaDispatchResult> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") {
    return {
      ok: false,
      message: "Moss Computer Use OS input injection is only implemented on macOS.",
    };
  }

  const planned = buildCliclickArgs(input);
  if (!planned.ok) {
    return { ok: false, message: planned.message };
  }
  if (planned.kind === "dry-run") {
    return {
      ok: true,
      message: "Moss Computer Use accepted this bounded dry-run without injecting OS input.",
    };
  }

  const bin = deps.whichCliclick ? await deps.whichCliclick() : await resolveCliclickBinary();
  if (!bin) {
    return {
      ok: false,
      message:
        "Moss Computer Use needs cliclick on this Mac (expected at /opt/homebrew/bin/cliclick or on PATH). Install with Homebrew: brew install cliclick.",
    };
  }

  const run = deps.runCliclick ?? runCliclickDefault;
  return run(bin, planned.args);
}
