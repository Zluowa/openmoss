import { ProjectId, type ProjectImportProject } from "@moss/contracts";
import { describe, expect, it } from "vitest";
import {
  buildProjectImportQueue,
  defaultProjectImportKeys,
  describeImportFailure,
  filterProjectImportsByProvider,
  IMPORT_PROVIDER_LABELS,
  IMPORT_PROVIDERS,
  projectImportItemKey,
  projectImportProviderCounts,
  projectImportProvidersNotFound,
  projectImportQuietNote,
  projectImportUnreadableNotes,
  selectableProjectImportKeys,
  shortenImportPath,
  projectImportNoConversationsNote,
  splitProjectImportNotFoundByDetection,
  isProjectImportProviderTurnedOff,
  projectImportTurnedOffNote,
} from "./logic";

const project: ProjectImportProject = {
  key: "folder:/code/moss",
  title: "Moss",
  workspaceRoot: "/code/moss",
  directoryExists: true,
  existingProjectId: ProjectId.makeUnsafe("existing"),
  providers: ["codex", "claudeAgent"],
  threads: [
    {
      key: "codex:one",
      provider: "codex",
      title: "One",
      cwd: "/code/moss",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      archived: false,
      alreadyImported: false,
    },
    {
      key: "claude:two",
      provider: "claudeAgent",
      title: "Two",
      cwd: "/code/moss",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      archived: true,
      alreadyImported: false,
    },
    {
      key: "codex:three",
      provider: "codex",
      title: "Three",
      cwd: "/code/moss",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      archived: false,
      alreadyImported: true,
    },
  ],
};

describe("project import selection", () => {
  it("skips duplicates and archived selections when the archive filter is off", () => {
    const selected = new Set(
      project.threads.map((thread) => projectImportItemKey(project.key, thread.key)),
    );
    const queue = buildProjectImportQueue({
      projects: [project],
      selected,
      includeArchived: false,
      workspaceRoots: {},
    });
    expect(queue.map((item) => item.input)).toEqual([
      { projectKey: project.key, threadKey: "codex:one", spaceId: null },
    ]);
    expect(
      buildProjectImportQueue({
        projects: [project],
        selected,
        includeArchived: true,
        workspaceRoots: {},
      }),
    ).toHaveLength(2);
  });

  it("links empty folders once and passes explicit moved-folder destinations", () => {
    const empty = { ...project, threads: [], existingProjectId: null };
    const selected = new Set(selectableProjectImportKeys(empty, false));
    expect(
      buildProjectImportQueue({
        projects: [empty],
        selected,
        includeArchived: false,
        workspaceRoots: { [empty.key]: " /code/moved " },
      }),
    ).toMatchObject([
      { workspaceRoot: "/code/moved", input: { threadKey: null, workspaceRoot: "/code/moved" } },
    ]);
    expect(
      selectableProjectImportKeys(
        { ...empty, existingProjectId: project.existingProjectId },
        false,
      ),
    ).toEqual([]);
  });

  it("does not conflate provider conversation ids or delimiter-containing project keys", () => {
    expect(projectImportItemKey("a:b", "c")).not.toBe(projectImportItemKey("a", "b:c"));
    expect(projectImportItemKey(project.key, "codex:one")).not.toBe(
      projectImportItemKey(project.key, "claude:one"),
    );
  });
});

describe("import failures and defaults", () => {
  it("keeps a retry only for failures that trying again can fix, in plain words", () => {
    expect(
      describeImportFailure({
        _tag: "WsRpcError",
        message: "The conversation file is no longer on this computer.",
        code: "PROJECT_IMPORT_FAILED",
        retryable: false,
      }),
    ).toEqual({ reason: "The conversation file is no longer on this computer.", transient: false });
    expect(
      describeImportFailure({
        _tag: "WsRpcError",
        message: "The disk was busy. Moss can try again.",
        code: "PROJECT_IMPORT_FAILED",
        retryable: true,
      }).transient,
    ).toBe(true);
    // Anything else the server rejected is permanent, and its raw text is never shown.
    expect(
      describeImportFailure({
        _tag: "WsRpcError",
        message: "Thread 'x' already exists for command 'thread.create'.",
        code: "ORCHESTRATION_COMMAND_REJECTED",
        retryable: false,
      }),
    ).toEqual({ reason: "Moss couldn't add this conversation.", transient: false });
    // No answer from the server at all: a dropped or busy connection is worth retrying.
    expect(describeImportFailure(new Error("socket closed"))).toEqual({
      reason: "Moss was busy for a moment. It can try again.",
      transient: true,
    });
  });

  it("leaves projects in temp folders unticked at first", () => {
    const temporary = { ...project, key: "folder:/tmp/check", temporary: true };
    expect(defaultProjectImportKeys([project, temporary], false)).toEqual(
      selectableProjectImportKeys(project, false),
    );
  });
});

describe("agents found on this computer", () => {
  const grokThread = {
    ...project.threads[0]!,
    key: "grok:four",
    provider: "grok" as const,
    title: "Four",
  };
  const grokOnly: ProjectImportProject = {
    ...project,
    key: "folder:/code/other",
    title: "Other",
    providers: ["grok"],
    threads: [grokThread],
  };
  const emptyFolder: ProjectImportProject = {
    ...project,
    key: "folder:/code/empty",
    providers: ["grok"],
    threads: [],
  };
  const emptyCodexFolder: ProjectImportProject = {
    ...project,
    key: "folder:/code/empty-codex",
    providers: ["codex"],
    threads: [],
  };

  it("scans every agent and names each one", () => {
    expect(IMPORT_PROVIDERS).toEqual([
      "codex",
      "claudeAgent",
      "cursor",
      "gemini",
      "antigravity",
      "grok",
      "opencode",
      "pi",
      "hermes",
      "devin",
      "omp",
      "zcode",
    ]);
    for (const provider of IMPORT_PROVIDERS) expect(IMPORT_PROVIDER_LABELS[provider]).toBeTruthy();
  });

  it("counts conversations per agent and lists the agents that had nothing", () => {
    const projects = [project, grokOnly];
    expect(projectImportProviderCounts(projects)).toEqual([
      { provider: "codex", count: 2 },
      { provider: "claudeAgent", count: 1 },
      { provider: "grok", count: 1 },
    ]);
    expect(
      projectImportProvidersNotFound(
        {
          projects,
          sources: [{ provider: "pi", error: "unreadable" }],
          unreadable: [{ provider: "antigravity", conversationCount: 4, reason: "encrypted" }],
        },
        IMPORT_PROVIDERS,
      ),
    ).toEqual(["cursor", "gemini", "opencode", "hermes", "devin", "omp", "zcode"]);
  });

  it("explains conversations that were found but can't be copied", () => {
    expect(
      projectImportUnreadableNotes({
        projects: [],
        sources: [],
        unreadable: [
          { provider: "antigravity", conversationCount: 1, reason: "encrypted" },
          { provider: "kimi", conversationCount: 3, reason: "unsupported-format" },
        ],
      }),
    ).toEqual([
      "Found 1 Antigravity conversation that can't be copied: Antigravity keeps them encrypted.",
      "Found 3 Kimi Code conversations that can't be copied yet: Moss can't read this Kimi Code format.",
    ]);
  });

  it("says a detected agent has no conversations yet instead of not found", () => {
    const status = (provider: string, state: "ready" | "notInstalled") =>
      ({
        provider,
        instanceId: provider,
        driver: provider,
        status: state === "ready" ? "ready" : "error",
        available: state === "ready",
        authStatus: "unknown",
        checkedAt: "2026-11-11T00:00:00.000Z",
        ...(state === "notInstalled" ? { readiness: { state: "notInstalled" } } : {}),
      }) as never;
    const split = splitProjectImportNotFoundByDetection(
      ["devin", "cursor", "gemini"],
      [status("devin", "ready"), status("cursor", "notInstalled")],
    );
    // Devin is connected in the agents step: it has no conversations, it is not "not found".
    expect(split).toEqual({ notFound: ["cursor", "gemini"], noConversations: ["devin"] });
    expect(projectImportNoConversationsNote(split.noConversations)).toBe(
      "No conversations yet: Devin.",
    );
    expect(projectImportNoConversationsNote([])).toBeNull();
    // Without detection, nothing moves.
    expect(splitProjectImportNotFoundByDetection(["devin"], undefined)).toEqual({
      notFound: ["devin"],
      noConversations: [],
    });
  });

  it("folds what won't be imported into one quiet line", () => {
    expect(projectImportQuietNote([], [])).toBeNull();
    expect(projectImportQuietNote(["cursor", "gemini"], [])).toBe("Not found: Cursor, Gemini.");
    expect(
      projectImportQuietNote(
        ["cursor"],
        [
          { provider: "antigravity", conversationCount: 2, reason: "encrypted" },
          { provider: "kimi", conversationCount: 1, reason: "unsupported-format" },
        ],
      ),
    ).toBe("Not found: Cursor · 3 can't be copied (Antigravity, Kimi Code).");
    expect(
      projectImportQuietNote(
        [],
        [{ provider: "antigravity", conversationCount: 2, reason: "encrypted" }],
      ),
    ).toBe("2 can't be copied (Antigravity).");
  });

  it("shortens folder paths for the project list", () => {
    expect(shortenImportPath("C:\\Users\\me\\code\\moss", "C:\\Users\\me")).toBe("~\\code\\moss");
    expect(shortenImportPath("/home/me/code/moss", "/home/me/")).toBe("~/code/moss");
    // A sibling folder that only starts with the same letters is not home.
    expect(shortenImportPath("/home/mesa/app", "/home/me")).toBe("/home/mesa/app");
    expect(
      shortenImportPath("/home/me/work/clients/acme-corp/services/billing-api", "/home/me"),
    ).toBe("~/…/services/billing-api");
    expect(
      shortenImportPath("D:\\agent-ctx\\deriver\\codex-home\\projects\\very-long-name", null),
    ).toBe("D:\\…\\projects\\very-long-name");
  });

  it("leaves out unticked agents' conversations and their empty project folders", () => {
    const filtered = filterProjectImportsByProvider(
      [project, grokOnly, emptyFolder, emptyCodexFolder],
      ["grok"],
    );
    expect(filtered.map((entry) => [entry.key, entry.threads.map((thread) => thread.key)])).toEqual(
      [
        [grokOnly.key, ["grok:four"]],
        [emptyFolder.key, []],
      ],
    );
    const queue = buildProjectImportQueue({
      projects: filterProjectImportsByProvider([project, grokOnly], ["codex"]),
      selected: new Set([
        projectImportItemKey(project.key, "codex:one"),
        projectImportItemKey(grokOnly.key, "grok:four"),
      ]),
      includeArchived: false,
      workspaceRoots: {},
    });
    expect(queue.map((item) => item.input.threadKey)).toEqual(["codex:one"]);
  });
});

describe("agents switched off on the agents step", () => {
  it("are not offered, and one line names those with conversations", () => {
    expect(isProjectImportProviderTurnedOff("zcode", ["zcode", "cursor"])).toBe(true);
    expect(isProjectImportProviderTurnedOff("codex", ["zcode"])).toBe(false);
    expect(isProjectImportProviderTurnedOff("codex", undefined)).toBe(false);
    expect(projectImportTurnedOffNote([{ provider: "zcode", count: 70 }])).toBe(
      "Not turned on: ZCode (70). Turn it on in the agents list to import these conversations.",
    );
    expect(projectImportTurnedOffNote([])).toBeNull();
  });
});
