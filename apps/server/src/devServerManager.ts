/**
 * DevServerManager - Server-owned dev-server process orchestration.
 *
 * Dev servers are first-class background processes keyed by project id, fully
 * decoupled from chat threads. Each runs in a managed PTY (via TerminalManager)
 * under a synthetic `dev-server:<projectId>` thread so its lifetime survives
 * WebSocket reconnects and never clutters the thread list. The manager keeps an
 * in-memory registry, broadcasts changes over a PubSub for the
 * `project.devServerEvent` push channel, and reaps entries when their PTY exits.
 *
 * @module DevServerManager
 */
import {
  DEFAULT_TERMINAL_ID,
  ProjectId,
  type ProjectDevServer,
  type ProjectDevServerEvent,
  type ProjectListDevServersResult,
  type ProjectReadDevServerLogInput,
  type ProjectReadDevServerLogResult,
  type ProjectRunDevServerInput,
  type ProjectRunDevServerResult,
  type ProjectStopDevServerInput,
  type ProjectStopDevServerResult,
  type ServerLocalServerProcess,
} from "@moss/contracts";
import { localServerMatchesRun } from "@moss/shared/localServers";
import { Effect, Layer, PubSub, Ref, ServiceMap, Stream } from "effect";
import net from "node:net";

import { envPathKeyFor } from "@moss/shared/executable";

import {
  commandProgram,
  launchEnvironment,
  LaunchProgramNotFoundError,
  resolveLaunchProgram,
} from "./launchEnvironment";
import { TerminalManager, type TerminalError } from "./terminal/Services/Manager";

// Dev servers reuse the terminal infrastructure under a reserved synthetic
// thread namespace so their PTYs never collide with real chat-thread terminals.
const DEV_SERVER_THREAD_PREFIX = "dev-server:";
const DEV_SERVER_TERMINAL_COLS = 120;
const DEV_SERVER_TERMINAL_ROWS = 30;

const devServerThreadId = (projectId: ProjectId): string =>
  `${DEV_SERVER_THREAD_PREFIX}${projectId}`;

// A launch configuration's run is its own terminal in the project's dev-server thread,
// so several can run side by side; the project's sidebar run keeps the default one.
const LAUNCH_TERMINAL_PREFIX = "launch:";
const devServerTerminalId = (launchName: string | undefined): string =>
  launchName ? `${LAUNCH_TERMINAL_PREFIX}${launchName}` : DEFAULT_TERMINAL_ID;
const launchNameFromTerminalId = (terminalId: string): string | undefined =>
  terminalId.startsWith(LAUNCH_TERMINAL_PREFIX)
    ? terminalId.slice(LAUNCH_TERMINAL_PREFIX.length)
    : undefined;

/** Registry key: the project, plus the launch configuration's name for a launch run. */
export const devServerRunKey = (projectId: ProjectId, launchName?: string): string =>
  launchName ? `${projectId}\u0000${launchName}` : projectId;

// A launch run is "starting" until its port answers: the configured one, or one it
// prints (`Local: http://localhost:5174/` when the usual port was taken).
const READINESS_POLL_INTERVAL_MS = 500;
const READINESS_TIMEOUT_MS = 120_000;
const PORT_PROBE_TIMEOUT_MS = 400;
const PRINTED_LOCAL_URL_PATTERN =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::(\d{2,5}))/gi;

/** Ports a dev server announced in its output, in the order printed, without repeats. */
export function portsPrintedInOutput(output: string): number[] {
  const ports: number[] = [];
  for (const match of output.matchAll(PRINTED_LOCAL_URL_PATTERN)) {
    const port = Number(match[1]);
    if (Number.isInteger(port) && port > 0 && port <= 65_535 && !ports.includes(port)) {
      ports.push(port);
    }
  }
  return ports;
}

function probePortOnHost(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const finish = (answered: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(answered);
    };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** Whether something accepts connections on localhost:`port` (IPv4 or IPv6). */
export async function localPortAnswers(port: number): Promise<boolean> {
  if (await probePortOnHost(port, "127.0.0.1")) return true;
  return probePortOnHost(port, "::1");
}

const parseDevServerProjectId = (threadId: string): ProjectId | null => {
  if (!threadId.startsWith(DEV_SERVER_THREAD_PREFIX)) {
    return null;
  }
  const raw = threadId.slice(DEV_SERVER_THREAD_PREFIX.length);
  return raw.length > 0 ? ProjectId.makeUnsafe(raw) : null;
};

export function findProjectDevServerForLocalServer(input: {
  localServer: ServerLocalServerProcess;
  devServers: readonly ProjectDevServer[];
}): ProjectDevServer | null {
  // Several runs can share a project folder: the process, then the port, decides first.
  const { localServer } = input;
  const byProcess = input.devServers.find(
    (devServer) =>
      devServer.pid !== null &&
      (localServer.pid === devServer.pid || localServer.ppid === devServer.pid),
  );
  if (byProcess) return byProcess;
  const byPort = input.devServers.find(
    (devServer) => devServer.port !== undefined && localServer.ports.includes(devServer.port),
  );
  if (byPort) return byPort;
  for (const devServer of input.devServers) {
    if (localServerMatchesRun(localServer, devServer)) {
      return devServer;
    }
  }
  return null;
}

const EXIT_OUTPUT_TAIL_CHARS = 1_200;

function removedEvent(
  projectId: ProjectId,
  launchName: string | undefined,
  reason: "stopped" | "exited",
  output?: string | null,
): ProjectDevServerEvent {
  return {
    type: "removed",
    projectId,
    reason,
    ...(launchName ? { launchName } : {}),
    ...(output ? { output: output.slice(-EXIT_OUTPUT_TAIL_CHARS) } : {}),
  };
}

export interface DevServerManagerShape {
  /** Start (or restart) the dev server for a project and return its descriptor. */
  readonly run: (
    input: ProjectRunDevServerInput,
  ) => Effect.Effect<ProjectRunDevServerResult, TerminalError | LaunchProgramNotFoundError>;
  /** Stop the dev server for a project. Resolves with whether one was running. */
  readonly stop: (input: ProjectStopDevServerInput) => Effect.Effect<ProjectStopDevServerResult>;
  /** Snapshot of all currently tracked dev servers. */
  readonly list: Effect.Effect<ProjectListDevServersResult>;
  /** Recent output of a project's dev server; null when none is tracked. */
  readonly readLog: (
    input: ProjectReadDevServerLogInput,
  ) => Effect.Effect<ProjectReadDevServerLogResult>;
  /** Live stream of dev-server lifecycle events (excludes the initial snapshot). */
  readonly stream: Stream.Stream<ProjectDevServerEvent>;
}

export class DevServerManager extends ServiceMap.Service<DevServerManager, DevServerManagerShape>()(
  "moss/devServerManager",
) {}

export const DevServerManagerLive = Layer.effect(
  DevServerManager,
  Effect.gen(function* () {
    const terminalManager = yield* TerminalManager;
    const pubsub = yield* Effect.acquireRelease(
      PubSub.unbounded<ProjectDevServerEvent>(),
      PubSub.shutdown,
    );
    const registry = yield* Ref.make<Record<string, ProjectDevServer>>({});

    const publish = (event: ProjectDevServerEvent) => PubSub.publish(pubsub, event);

    // Reap a tracked dev server whose PTY exited or errored. Guarded so that a
    // deliberate stop (which removes the entry first) cannot double-publish, and
    // so a stale exit for an already-replaced project is ignored.
    const reapExited = (projectId: ProjectId, launchName: string | undefined) =>
      Ref.modify(registry, (current) => {
        const key = devServerRunKey(projectId, launchName);
        if (!current[key]) {
          return [false, current] as const;
        }
        const next = { ...current };
        delete next[key];
        return [true, next] as const;
      }).pipe(
        Effect.flatMap((removed) => {
          if (!removed) return Effect.void;
          // A launch run that ends by itself usually failed: say why with its last lines.
          const readOutput =
            launchName && terminalManager.readHistory
              ? terminalManager.readHistory({
                  threadId: devServerThreadId(projectId),
                  terminalId: devServerTerminalId(launchName),
                })
              : Effect.succeed(null);
          return readOutput.pipe(
            Effect.flatMap((output) =>
              publish(removedEvent(projectId, launchName, "exited", output)),
            ),
          );
        }),
      );

    const unsubscribe = yield* terminalManager.subscribe((event) => {
      if (event.type !== "exited" && event.type !== "error") {
        return;
      }
      const projectId = parseDevServerProjectId(event.threadId);
      if (!projectId) {
        return;
      }
      Effect.runFork(reapExited(projectId, launchNameFromTerminalId(event.terminalId)));
    });

    // Watches a launch run until a port answers, then marks it running with its address.
    // Stops quietly once the run is gone or replaced (a new start has a new startedAt).
    const watchReadiness = async (server: ProjectDevServer, configuredPort: number | undefined) => {
      const key = devServerRunKey(server.projectId, server.launchName);
      const threadId = devServerThreadId(server.projectId);
      const terminalId = devServerTerminalId(server.launchName);
      const deadline = Date.now() + READINESS_TIMEOUT_MS;
      const stillCurrent = () =>
        Effect.runSync(Ref.get(registry))[key]?.startedAt === server.startedAt;
      while (Date.now() < deadline && stillCurrent()) {
        await new Promise((resolve) => setTimeout(resolve, READINESS_POLL_INTERVAL_MS));
        if (!stillCurrent()) return;
        const output = terminalManager.readHistory
          ? await Effect.runPromise(terminalManager.readHistory({ threadId, terminalId })).catch(
              () => null,
            )
          : null;
        // The port it printed last wins (a busy usual port moves the server along).
        const candidates = [
          ...(output ? portsPrintedInOutput(output) : []).toReversed(),
          ...(configuredPort !== undefined ? [configuredPort] : []),
        ].filter((port, index, all) => all.indexOf(port) === index);
        for (const port of candidates) {
          if (!(await localPortAnswers(port))) continue;
          const ready = Effect.runSync(
            Ref.modify(registry, (current) => {
              const entry = current[key];
              if (!entry || entry.startedAt !== server.startedAt) {
                return [null, current] as const;
              }
              const next: ProjectDevServer = {
                ...entry,
                status: "running",
                port,
                url: `http://localhost:${port}/`,
              };
              return [next, { ...current, [key]: next }] as const;
            }),
          );
          if (ready) Effect.runFork(publish({ type: "upserted", server: ready }));
          return;
        }
      }
    };
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

    const run: DevServerManagerShape["run"] = (input) =>
      Effect.gen(function* () {
        const threadId = devServerThreadId(input.projectId);
        const terminalId = devServerTerminalId(input.launchName);
        const key = devServerRunKey(input.projectId, input.launchName);

        // The run gets the PATH the person's terminal would have, so a tool installed
        // after Moss started (or a Moss started with a thin PATH) is still found. A launch
        // configuration's program is looked up there first: a missing one is reported by
        // name before anything starts, never as the shell's error text.
        const baseEnv = launchEnvironment();
        const pathKey = envPathKeyFor(process.env);
        const runEnv: Record<string, string> = {
          ...input.env,
          ...(baseEnv[pathKey] ? { [pathKey]: baseEnv[pathKey] } : {}),
        };
        if (input.launchName) {
          const program = commandProgram(input.command);
          if (
            program &&
            resolveLaunchProgram(program, {
              env: { ...baseEnv, ...runEnv },
              cwd: input.cwd,
            }) === null
          ) {
            return yield* Effect.fail(new LaunchProgramNotFoundError(program));
          }
        }

        // If this run is already tracked, tear its PTY down first so the command
        // always lands in a fresh shell. A deliberate close emits no exit event, so
        // the reaper stays quiet during the swap.
        const existing = (yield* Ref.get(registry))[key];
        if (existing) {
          yield* terminalManager
            .close({ threadId, terminalId, deleteHistory: true })
            .pipe(Effect.catch(() => Effect.void));
        }

        const snapshot = yield* terminalManager.open({
          threadId,
          terminalId,
          cwd: input.cwd,
          cols: DEV_SERVER_TERMINAL_COLS,
          rows: DEV_SERVER_TERMINAL_ROWS,
          // Dev servers are headless: drain + retain history, but never broadcast
          // their continuous output to clients that have no terminal UI for them.
          streamOutput: false,
          env: runEnv,
        });

        // A launch run's shell ends with its command, so a server that fails to start
        // shows as stopped (with its output) instead of starting forever.
        yield* terminalManager.write({
          threadId,
          terminalId,
          data: input.launchName ? `${input.command}; exit\r` : `${input.command}\r`,
        });

        const server: ProjectDevServer = {
          projectId: input.projectId,
          command: input.command,
          cwd: input.cwd,
          pid: snapshot.pid,
          startedAt: new Date().toISOString(),
          // The sidebar run is reported as running at once, as before; a launch run
          // waits for its port so the panel opens a page that answers.
          status: input.launchName ? "starting" : "running",
          ...(input.launchName ? { launchName: input.launchName } : {}),
          ...(input.port !== undefined ? { port: input.port } : {}),
        };
        yield* Ref.update(registry, (current) => ({ ...current, [key]: server }));
        yield* publish({ type: "upserted", server });
        if (input.launchName) {
          void watchReadiness(server, input.port);
        }
        return { server };
      });

    const stop: DevServerManagerShape["stop"] = (input) =>
      Effect.gen(function* () {
        // Remove from the registry *before* closing so the PTY teardown cannot be
        // mistaken for a crash by the reaper.
        const key = devServerRunKey(input.projectId, input.launchName);
        const removed = yield* Ref.modify(registry, (current) => {
          if (!current[key]) {
            return [false, current] as const;
          }
          const next = { ...current };
          delete next[key];
          return [true, next] as const;
        });
        if (!removed) {
          return { stopped: false };
        }
        yield* publish(removedEvent(input.projectId, input.launchName, "stopped"));
        yield* terminalManager
          .close({
            threadId: devServerThreadId(input.projectId),
            terminalId: devServerTerminalId(input.launchName),
            deleteHistory: true,
          })
          .pipe(Effect.catch(() => Effect.void));
        return { stopped: true };
      });

    const list: DevServerManagerShape["list"] = Ref.get(registry).pipe(
      Effect.map((current) => ({ servers: Object.values(current) })),
    );

    // Read only: the dev server's PTY keeps draining its output into history, and this
    // copies that history without attaching a viewer or touching the process.
    const readLog: DevServerManagerShape["readLog"] = (input) =>
      Effect.gen(function* () {
        const key = devServerRunKey(input.projectId, input.launchName);
        if (!(yield* Ref.get(registry))[key] || !terminalManager.readHistory) {
          return { log: null };
        }
        const log = yield* terminalManager.readHistory({
          threadId: devServerThreadId(input.projectId),
          terminalId: devServerTerminalId(input.launchName),
        });
        return { log };
      });

    return {
      run,
      stop,
      list,
      readLog,
      get stream() {
        return Stream.fromPubSub(pubsub);
      },
    } satisfies DevServerManagerShape;
  }),
);
