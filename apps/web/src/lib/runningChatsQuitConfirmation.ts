// FILE: runningChatsQuitConfirmation.ts
// Purpose: Lists the work a desktop quit would stop (chats, terminal commands, dev servers,
//          imports, an app update download) and builds the quit confirmation copy. Quit
//          asks only when this list is not empty.
// Layer: UI logic helper
// Depends on: Sidebar-equivalent "working" signals (running/connecting/live tail).

export interface RunningChatQuitCandidate {
  readonly id: string;
  readonly title: string;
  readonly hasLiveTailWork?: boolean | undefined;
  readonly session?: { readonly status?: string | null } | null | undefined;
}

export interface RunningChatQuitSummary {
  readonly id: string;
  readonly title: string;
}

export interface RunningChatsQuitCopy {
  readonly title: string;
  readonly description: string;
  readonly resumeLabel: string;
  readonly stayLabel: string;
  readonly quitLabel: string;
}

/** Bounded wait for the server to record the resume intent; quit must stay snappy. */
export const QUIT_RESUME_PREPARE_TIMEOUT_MS = 1500;

export interface RunningChatsQuitStoreSlice {
  readonly sidebarThreadSummaryById: Readonly<Record<string, RunningChatQuitCandidate>>;
  readonly threadSessionById?: Readonly<
    Record<string, { readonly status?: string | null } | null | undefined>
  >;
  readonly threadShellById?: Readonly<Record<string, { readonly title?: string } | undefined>>;
}

const UNTITLED_CHAT_TITLE = "Untitled thread";

function runningChatDisplayTitle(title: string | null | undefined): string {
  const trimmed = title?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : UNTITLED_CHAT_TITLE;
}

export function isRunningChatForQuit(thread: {
  readonly hasLiveTailWork?: boolean | undefined;
  readonly session?: { readonly status?: string | null } | null | undefined;
}): boolean {
  if (thread.hasLiveTailWork === true) {
    return true;
  }
  const status = thread.session?.status;
  return status === "running" || status === "connecting";
}

export function listRunningChatsForQuit(
  threads: ReadonlyArray<RunningChatQuitCandidate>,
): ReadonlyArray<RunningChatQuitSummary> {
  const seen = new Set<string>();
  const chats: RunningChatQuitSummary[] = [];
  for (const thread of threads) {
    if (seen.has(thread.id) || !isRunningChatForQuit(thread)) {
      continue;
    }
    seen.add(thread.id);
    chats.push({ id: thread.id, title: runningChatDisplayTitle(thread.title) });
  }
  return chats.sort(compareRunningChatSummaries);
}

export function listRunningChatsFromDesktopStore(
  state: RunningChatsQuitStoreSlice,
): ReadonlyArray<RunningChatQuitSummary> {
  const candidates: RunningChatQuitCandidate[] = Object.values(state.sidebarThreadSummaryById);
  const listedIds = new Set(candidates.map((thread) => thread.id));

  for (const [id, session] of Object.entries(state.threadSessionById ?? {})) {
    if (listedIds.has(id)) {
      continue;
    }
    candidates.push({
      id,
      title: state.threadShellById?.[id]?.title ?? "",
      session,
    });
  }

  return listRunningChatsForQuit(candidates);
}

/** Running work other than chats that quitting would stop. */
export type RunningWorkQuitKind = "terminal" | "devServer" | "import" | "updateDownload";

export interface RunningWorkQuitItem {
  readonly id: string;
  readonly kind: RunningWorkQuitKind;
  /** What the person recognises it by (chat title, dev-server command); may be empty. */
  readonly detail: string;
}

/** Row label for each kind; zh-CN comes from the presentation phrase table. */
export const RUNNING_WORK_QUIT_LABELS: Readonly<Record<RunningWorkQuitKind, string>> = {
  terminal: "Terminal command",
  devServer: "Dev server",
  import: "Importing conversations",
  updateDownload: "Downloading an app update",
};

export interface RunningWorkQuitSources {
  /** Per chat, the terminals whose shell is running a command (a dev server, a build…). */
  readonly terminalStateByThreadId: Readonly<
    Record<string, { readonly runningTerminalIds: ReadonlyArray<string> } | undefined>
  >;
  readonly threadTitleById: (threadId: string) => string | null | undefined;
  readonly devServers: ReadonlyArray<{
    readonly projectId: string;
    readonly command: string;
    readonly status: string;
  }>;
  readonly projectNameById: (projectId: string) => string | null | undefined;
  readonly imports: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly updateDownloading: boolean;
}

/** Everything besides chats that would stop on quit, in a stable order. */
export function listRunningWorkForQuit(
  sources: RunningWorkQuitSources,
): ReadonlyArray<RunningWorkQuitItem> {
  const items: RunningWorkQuitItem[] = [];
  for (const [threadId, state] of Object.entries(sources.terminalStateByThreadId)) {
    for (const terminalId of new Set(state?.runningTerminalIds ?? [])) {
      items.push({
        id: `terminal:${threadId}:${terminalId}`,
        kind: "terminal",
        detail: runningChatDisplayTitle(sources.threadTitleById(threadId)),
      });
    }
  }
  for (const server of sources.devServers) {
    if (server.status !== "running" && server.status !== "starting") continue;
    const project = sources.projectNameById(server.projectId)?.trim();
    items.push({
      id: `devServer:${server.projectId}`,
      kind: "devServer",
      detail: project ? `${project} · ${server.command}` : server.command,
    });
  }
  for (const entry of sources.imports) {
    items.push({ id: `import:${entry.id}`, kind: "import", detail: entry.label });
  }
  if (sources.updateDownloading) {
    items.push({ id: "updateDownload", kind: "updateDownload", detail: "" });
  }
  const kindOrder: Record<RunningWorkQuitKind, number> = {
    terminal: 0,
    devServer: 1,
    import: 2,
    updateDownload: 3,
  };
  return items.toSorted(
    (left, right) =>
      kindOrder[left.kind] - kindOrder[right.kind] ||
      left.detail.localeCompare(right.detail) ||
      left.id.localeCompare(right.id),
  );
}

export function runningChatsQuitCopy(
  chats: ReadonlyArray<RunningChatQuitSummary>,
  appName = "Moss",
  otherWork: ReadonlyArray<RunningWorkQuitItem> = [],
): RunningChatsQuitCopy {
  return {
    title:
      otherWork.length > 0 || chats.length === 0
        ? "Work is still running"
        : chats.length === 1
          ? "A chat is still running"
          : "Chats are still running",
    description: `Work in progress will stop when ${appName} is closed.`,
    resumeLabel: chats.length === 1 ? "Resume chat automatically" : "Resume chats automatically",
    stayLabel: "Cancel",
    quitLabel: "Quit",
  };
}

/** The ordinary user turn dispatched on each remembered chat at the next launch. */
export function quitResumeContinuationPrompt(appName = "Moss"): string {
  return `${appName} was closed while this chat was still running. Continue where you left off.`;
}

export interface StopRunningChatsForQuitInput {
  readonly chats: ReadonlyArray<Pick<RunningChatQuitSummary, "id">>;
  readonly dispatchInterrupt: (threadId: string) => Promise<unknown> | unknown;
  /**
   * When set, ask the server to durably record the chats for resume (it also
   * interrupts them) and wait — bounded — for that ack. On failure or timeout
   * fall back to plain interrupts so quit never hangs and never double-resumes.
   */
  readonly resume?: {
    readonly prepare: (threadIds: ReadonlyArray<string>) => Promise<unknown>;
    readonly timeoutMs?: number;
  };
}

export interface StopRunningChatsForQuitResult {
  /** True when the server acknowledged the resume record (and owns the interrupts). */
  readonly resumeRecorded: boolean;
}

export async function stopRunningChatsForQuit(
  input: StopRunningChatsForQuitInput,
): Promise<StopRunningChatsForQuitResult> {
  if (input.chats.length === 0) {
    return { resumeRecorded: false };
  }
  const threadIds = input.chats.map((chat) => chat.id);

  if (input.resume) {
    const recorded = await withBoundedWait(
      () => input.resume!.prepare(threadIds),
      input.resume.timeoutMs ?? QUIT_RESUME_PREPARE_TIMEOUT_MS,
    );
    if (recorded) {
      return { resumeRecorded: true };
    }
  }

  // Fire-and-forget: the window must close as soon as the outcome is known, and an
  // interrupt RPC against an unresponsive server could otherwise hold quit for its
  // full transport timeout.
  for (const threadId of threadIds) {
    void new Promise((resolve) => resolve(input.dispatchInterrupt(threadId))).catch(() => {});
  }
  return { resumeRecorded: false };
}

/** Resolves true only when `run` settles successfully within `timeoutMs`. */
async function withBoundedWait(run: () => Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(run)
        .then(
          () => true,
          () => false,
        ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function compareRunningChatSummaries(
  left: RunningChatQuitSummary,
  right: RunningChatQuitSummary,
): number {
  const byTitle = left.title.localeCompare(right.title);
  if (byTitle !== 0) {
    return byTitle;
  }
  return left.id.localeCompare(right.id);
}
