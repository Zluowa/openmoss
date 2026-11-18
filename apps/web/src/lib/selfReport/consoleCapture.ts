// FILE: consoleCapture.ts
// Purpose: `console_report`: the renderer's errors and warnings since the last call (console
//          errors and warnings, uncaught errors, unhandled rejections). Installed once, as early as
//          the app starts, only where self-report is enabled; the console keeps working as before.
// Layer: Web dev/test tooling (self-report)

export interface ConsoleEntry {
  readonly level: "error" | "warn";
  readonly text: string;
  readonly source?: string;
  readonly at: string;
}

export interface ConsoleReport {
  readonly entries: ConsoleEntry[];
  /** Entries lost because more than the buffer holds came in between two calls. */
  readonly dropped: number;
}

const MAX_ENTRIES = 300;
const MAX_TEXT = 1000;

let entries: ConsoleEntry[] = [];
let dropped = 0;
let uninstall: (() => void) | null = null;

function describe(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function record(entry: Omit<ConsoleEntry, "at" | "text"> & { readonly text: string }): void {
  if (entries.length >= MAX_ENTRIES) {
    dropped += 1;
    return;
  }
  entries.push({ ...entry, text: entry.text.slice(0, MAX_TEXT), at: new Date().toISOString() });
}

/** What the capture hooks: the window, or a stand-in with a console and events. */
export type ConsoleCaptureTarget = Pick<Window, "addEventListener" | "removeEventListener"> & {
  console: Pick<Console, "error" | "warn">;
};

/** Starts recording; calling it again does nothing. Returns a function that stops it. */
export function installConsoleCapture(
  target: ConsoleCaptureTarget = window as unknown as ConsoleCaptureTarget,
): () => void {
  if (uninstall) return uninstall;
  const original = { error: target.console.error, warn: target.console.warn };
  target.console.error = (...args: unknown[]) => {
    record({ level: "error", text: args.map(describe).join(" ") });
    original.error.apply(target.console, args);
  };
  target.console.warn = (...args: unknown[]) => {
    record({ level: "warn", text: args.map(describe).join(" ") });
    original.warn.apply(target.console, args);
  };
  const onError = (event: ErrorEvent) => {
    record({
      level: "error",
      text: event.error !== undefined ? describe(event.error) : event.message,
      ...(event.filename ? { source: `${event.filename}:${event.lineno}:${event.colno}` } : {}),
    });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    record({ level: "error", text: `Unhandled rejection: ${describe(event.reason)}` });
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  uninstall = () => {
    target.console.error = original.error;
    target.console.warn = original.warn;
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
    uninstall = null;
  };
  return uninstall;
}

/** What was recorded since the last call; the buffer starts again empty. */
export function consoleReport(): ConsoleReport {
  const report = { entries, dropped };
  entries = [];
  dropped = 0;
  return report;
}
