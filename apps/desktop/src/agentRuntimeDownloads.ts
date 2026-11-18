// FILE: agentRuntimeDownloads.ts
// Purpose: Fetches the agent runtimes a `download` build leaves out of the installer: the
//          default agent's runtime (Codex) the moment the app opens, then the others in the
//          background, paused while a chat is running. Reports progress for the window, ready
//          runtimes for the server and each fetch's outcome for diagnostics.
// Layer: Electron main process (transport and timers injected, so it is tested without Electron)

import { readFile } from "node:fs/promises";
import * as Path from "node:path";

import {
  type AgentRuntimeFailure,
  type AgentRuntimeFetchReport,
  type AgentRuntimePin,
  AgentRuntimeStoreError,
  ensureAgentRuntime,
  findAgentRuntime,
} from "@moss/shared/agentRuntimeStore";
import type { PinnedDownloadFetch } from "@moss/shared/pinnedDownload";
import type { DesktopAgentRuntimeState } from "@moss/contracts";

/** Written into app.asar by a `download` build (scripts/lib/agent-runtime-archives.ts). */
export const AGENT_RUNTIME_PINS_FILE = "agent-runtime-pins.json";

/** What the window shows for one runtime (no URL, no path); the bridge carries it as is. */
export type AgentRuntimeDownloadState = DesktopAgentRuntimeState;
export type AgentRuntimeDownloadPhase = DesktopAgentRuntimeState["phase"];

/**
 * Reads the pins a `download` build embedded. Null for a bundled build (no file) or when the
 * file names another platform. The default agent's runtime comes first.
 */
export async function loadAgentRuntimePins(input: {
  readonly appPath: string;
  readonly platform: string;
  readonly arch: string;
  readonly readText?: (path: string) => Promise<string>;
}): Promise<ReadonlyArray<AgentRuntimePin> | null> {
  const readText = input.readText ?? ((path: string) => readFile(path, "utf8"));
  let document: { schemaVersion?: unknown; runtimes?: unknown };
  try {
    document = JSON.parse(await readText(Path.join(input.appPath, AGENT_RUNTIME_PINS_FILE)));
  } catch {
    return null;
  }
  if (document.schemaVersion !== 1 || !Array.isArray(document.runtimes)) return null;
  const pins = (document.runtimes as AgentRuntimePin[]).filter(
    (pin) => pin.platform === input.platform && pin.arch === input.arch,
  );
  if (pins.length === 0) return null;
  return pins.toSorted((left, right) => defaultAgentFirst(left) - defaultAgentFirst(right));
}

/** The default agent of a new chat is Codex on every lane, so its runtime comes first. */
function defaultAgentFirst(pin: AgentRuntimePin): number {
  return pin.name === "codex" ? 0 : 1;
}

const SPEED_WINDOW_MS = 10_000;
/** After every source failed and the store gave up: try again by itself this often. */
const AUTOMATIC_RETRY_MS = 60_000;

export interface AgentRuntimeDownloads {
  /**
   * Looks up what is installed (resolves when that is known), then fetches what is missing in
   * the background, default runtime first.
   */
  start(): Promise<void>;
  /** The person pressed 重试 (or the network came back): try now. */
  retry(): void;
  /** A chat is running: pause background downloads (never the one the next message needs). */
  setBusy(busy: boolean): void;
  states(): ReadonlyArray<AgentRuntimeDownloadState>;
  /** Paths of the runtimes installed so far, by name. */
  readyPaths(): ReadonlyMap<string, string>;
  dispose(): void;
}

export function createAgentRuntimeDownloads(input: {
  readonly pins: ReadonlyArray<AgentRuntimePin>;
  readonly storeRoot: string;
  readonly preseededRoots?: ReadonlyArray<string>;
  /** Ordered source bases, decided when a download starts (the lane may be known by then). */
  readonly sourceBases: () => ReadonlyArray<string>;
  readonly fetch: PinnedDownloadFetch;
  readonly onChange: (states: ReadonlyArray<AgentRuntimeDownloadState>) => void;
  readonly onReady: (name: string, executablePath: string) => void;
  readonly onReport: (report: AgentRuntimeFetchReport) => void;
  readonly log?: (message: string) => void;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, ms: number) => { cancel(): void };
  readonly retryDelaysMs?: ReadonlyArray<number>;
}): AgentRuntimeDownloads {
  const now = input.now ?? Date.now;
  const setTimer =
    input.setTimer ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms);
      timer.unref?.();
      return { cancel: () => clearTimeout(timer) };
    });
  const states = new Map<string, AgentRuntimeDownloadState>(
    input.pins.map((pin) => [
      pin.name,
      {
        name: pin.name,
        version: pin.version,
        phase: "checking",
        bytes: 0,
        total: pin.archive.size,
        secondsLeft: null,
        failure: null,
        retryInMs: null,
      },
    ]),
  );
  const ready = new Map<string, string>();
  const samples = new Map<string, Array<{ at: number; bytes: number }>>();
  let busy = false;
  let disposed = false;
  let running: { name: string; controller: AbortController; background: boolean } | null = null;
  let retryTimer: { cancel(): void } | null = null;

  const emit = () => input.onChange([...states.values()]);
  const update = (name: string, patch: Partial<AgentRuntimeDownloadState>) => {
    const current = states.get(name);
    if (!current) return;
    states.set(name, { ...current, ...patch });
    emit();
  };
  const secondsLeft = (name: string, bytes: number, total: number): number | null => {
    const list = samples.get(name) ?? [];
    const at = now();
    list.push({ at, bytes });
    while (list.length > 2 && at - list[0]!.at > SPEED_WINDOW_MS) list.shift();
    samples.set(name, list);
    const first = list[0]!;
    const elapsed = (at - first.at) / 1000;
    const speed = elapsed >= 1 ? (bytes - first.bytes) / elapsed : 0;
    return speed > 0 ? Math.ceil((total - bytes) / speed) : null;
  };

  const markReady = (pin: AgentRuntimePin, executablePath: string) => {
    ready.set(pin.name, executablePath);
    update(pin.name, {
      phase: "ready",
      bytes: pin.archive.size,
      secondsLeft: 0,
      failure: null,
      retryInMs: null,
    });
    input.onReady(pin.name, executablePath);
  };

  /** Fetches every missing runtime in order; stops at the first one that cannot be fetched now. */
  const pump = async (): Promise<void> => {
    if (disposed || running) return;
    for (const [index, pin] of input.pins.entries()) {
      if (ready.has(pin.name)) continue;
      const background = index > 0;
      if (background && busy) {
        update(pin.name, { phase: "paused" });
        return;
      }
      const controller = new AbortController();
      running = { name: pin.name, controller, background };
      samples.delete(pin.name);
      update(pin.name, { phase: "downloading", failure: null, retryInMs: null });
      try {
        const result = await ensureAgentRuntime({
          pin,
          storeRoot: input.storeRoot,
          ...(input.preseededRoots ? { preseededRoots: input.preseededRoots } : {}),
          sourceBases: input.sourceBases(),
          fetch: input.fetch,
          signal: controller.signal,
          ...(input.retryDelaysMs ? { retryDelaysMs: input.retryDelaysMs } : {}),
          onStatus: (status) => {
            if (status.phase === "downloading")
              update(pin.name, {
                phase: "downloading",
                bytes: status.bytes,
                total: status.total,
                secondsLeft: secondsLeft(pin.name, status.bytes, status.total),
              });
            else if (status.phase === "waiting")
              update(pin.name, {
                phase: "waiting",
                bytes: status.bytes,
                failure: status.failure,
                retryInMs: status.retryInMs,
                secondsLeft: null,
              });
            else if (status.phase === "installing") update(pin.name, { phase: "installing" });
          },
        });
        running = null;
        if (result.report.outcome !== "already-installed") input.onReport(result.report);
        markReady(pin, result.executablePath);
      } catch (error) {
        running = null;
        const failure: AgentRuntimeFailure =
          error instanceof AgentRuntimeStoreError ? error.failure : "unreachable";
        if (failure === "aborted") {
          // Paused for a running chat, or disposed: the partial file stays for the resume.
          if (!disposed) update(pin.name, { phase: busy && background ? "paused" : "queued" });
          return;
        }
        input.log?.(`[agent-runtimes] ${pin.name} ${pin.version}: ${failure}`);
        input.onReport({
          name: pin.name,
          version: pin.version,
          outcome: failure,
          durationMs: 0,
          installMs: 0,
          download: error instanceof AgentRuntimeStoreError ? (error.download ?? null) : null,
          replacedDamaged: false,
        });
        update(pin.name, {
          phase: "failed",
          failure,
          secondsLeft: null,
          retryInMs: AUTOMATIC_RETRY_MS,
        });
        retryTimer?.cancel();
        retryTimer = setTimer(() => {
          retryTimer = null;
          void pump();
        }, AUTOMATIC_RETRY_MS);
        return;
      }
    }
  };

  return {
    async start() {
      // What is already there is known before anything else starts (the server's first
      // environment carries it); missing runtimes then download in the background.
      for (const pin of input.pins) {
        const found = await findAgentRuntime(
          [...(input.preseededRoots ?? []), input.storeRoot],
          pin,
        ).catch(() => ({ state: "missing" as const }));
        if (found.state === "ready") markReady(pin, found.executablePath);
        else update(pin.name, { phase: "queued" });
      }
      void pump();
    },
    retry() {
      retryTimer?.cancel();
      retryTimer = null;
      void pump();
    },
    setBusy(next) {
      busy = next;
      if (busy && running?.background) running.controller.abort();
      if (!busy) void pump();
    },
    states: () => [...states.values()],
    readyPaths: () => new Map(ready),
    dispose() {
      disposed = true;
      retryTimer?.cancel();
      running?.controller.abort();
    },
  };
}
