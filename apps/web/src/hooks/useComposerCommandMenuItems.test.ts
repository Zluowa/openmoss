import { describe, expect, it } from "vitest";

import type { ComposerThreadMentionSource, Project } from "../types";
import {
  buildThreadMentionComposerItems,
  devsReportMenuItems,
  resolveThreadMentionForThreadId,
  useComposerCommandMenuItems,
} from "./useComposerCommandMenuItems";

function project(id: string, kind: Project["kind"], name: string): Project {
  return {
    id,
    kind,
    name,
    remoteName: name,
    folderName: name,
    localName: null,
    cwd: `/workspace/${id}`,
    defaultModelSelection: null,
    expanded: true,
    scripts: [],
  } as unknown as Project;
}

function thread(input: {
  id: string;
  projectId: string;
  title: string;
  provider?: "codex" | "claudeAgent";
  updatedAt?: string;
  archivedAt?: string | null;
}): ComposerThreadMentionSource {
  return {
    id: input.id,
    projectId: input.projectId,
    title: input.title,
    provider: input.provider ?? "codex",
    createdAt: input.updatedAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: input.updatedAt,
    archivedAt: input.archivedAt ?? null,
    latestUserMessageAt: null,
  } as unknown as ComposerThreadMentionSource;
}

describe("buildThreadMentionComposerItems", () => {
  const projects = [
    project("project", "project", "Moss"),
    project("chats", "chat", "Home"),
    project("studio", "studio", "Studio workspace"),
  ];

  it("searches titles across project, chat, and group sections and excludes the current thread", () => {
    const items = buildThreadMentionComposerItems({
      projects,
      currentThreadId: "current",
      query: "release",
      threads: [
        thread({ id: "current", projectId: "project", title: "Release current" }),
        thread({ id: "project-thread", projectId: "project", title: "Release Moss" }),
        thread({ id: "chat-thread", projectId: "chats", title: "Release notes" }),
        thread({
          id: "studio-thread",
          projectId: "studio",
          title: "Release artwork",
          provider: "claudeAgent",
        }),
        thread({ id: "unrelated", projectId: "project", title: "Bug triage" }),
      ],
    });

    expect(items.map((item) => item.id).toSorted()).toEqual([
      "thread:chat-thread",
      "thread:project-thread",
      "thread:studio-thread",
    ]);
    expect(Object.fromEntries(items.map((item) => [item.id, item.description]))).toEqual({
      "thread:chat-thread": "Chats",
      "thread:project-thread": "Moss",
      "thread:studio-thread": "Studio workspace",
    });
    expect(items.find((item) => item.id === "thread:studio-thread")).toMatchObject({
      provider: "claudeAgent",
      mention: { name: "Release artwork", path: "thread://studio-thread" },
    });
  });

  it("caps the unfiltered list to the 20 most recent active threads", () => {
    const threads = Array.from({ length: 24 }, (_, index) =>
      thread({
        id: `thread-${index}`,
        projectId: "project",
        title: index === 23 ? "" : `Thread ${index}`,
        updatedAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        archivedAt: index === 22 ? "2026-02-01T00:00:00.000Z" : null,
      }),
    );
    const items = buildThreadMentionComposerItems({
      projects,
      currentThreadId: null,
      query: "",
      threads,
    });

    expect(items).toHaveLength(20);
    expect(items[0]).toMatchObject({ label: "Untitled thread", id: "thread:thread-23" });
    expect(items.some((item) => item.id === "thread:thread-22")).toBe(false);
    expect(items.at(-1)?.id).toBe("thread:thread-3");
  });

  it("caps query-filtered results to the suggestion limit", () => {
    const threads = Array.from({ length: 30 }, (_, index) =>
      thread({ id: `thread-${index}`, projectId: "project", title: `Release ${index}` }),
    );
    const items = buildThreadMentionComposerItems({
      projects,
      currentThreadId: null,
      query: "release",
      threads,
    });

    expect(items).toHaveLength(20);
  });

  it("disambiguates duplicate titles with the project name so mention tokens stay unique", () => {
    const items = buildThreadMentionComposerItems({
      projects,
      currentThreadId: null,
      query: "planning",
      threads: [
        thread({ id: "in-project", projectId: "project", title: "Planning" }),
        thread({ id: "in-chats", projectId: "chats", title: "Planning" }),
        thread({ id: "unique", projectId: "project", title: "Planning extras" }),
      ],
    });

    const mentionNamesById = Object.fromEntries(
      items.map((item) => [item.id, item.type === "thread" ? item.mention.name : null]),
    );
    expect(mentionNamesById["thread:in-project"]).toBe("Planning (Moss)");
    expect(mentionNamesById["thread:in-chats"]).toBe("Planning (Chats)");
    expect(mentionNamesById["thread:unique"]).toBe("Planning extras");
    expect(items.every((item) => item.label.startsWith("Planning"))).toBe(true);
  });

  it("falls back to a thread-id suffix for duplicate titles inside the same project", () => {
    const items = buildThreadMentionComposerItems({
      projects,
      currentThreadId: null,
      query: "planning",
      threads: [
        thread({ id: "thread-aaa111", projectId: "project", title: "Planning" }),
        thread({ id: "thread-bbb222", projectId: "project", title: "Planning" }),
      ],
    });

    const names = items.map((item) => (item.type === "thread" ? item.mention.name : "")).toSorted();
    expect(names).toEqual(["Planning (Moss, aaa111)", "Planning (Moss, bbb222)"]);
  });

  it("keeps generated names unique when a qualified name matches another real title", () => {
    const items = buildThreadMentionComposerItems({
      projects,
      currentThreadId: null,
      query: "planning",
      threads: [
        thread({ id: "thread-111111", projectId: "project", title: "Planning" }),
        thread({ id: "thread-222222", projectId: "chats", title: "Planning" }),
        thread({
          id: "thread-333333",
          projectId: "project",
          title: "Planning (Moss)",
        }),
      ],
    });

    const names = items.map((item) => (item.type === "thread" ? item.mention.name : ""));
    expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(names.length);
    expect(names).toContain("Planning (Moss) (111111)");
    expect(names).toContain("Planning (Moss) (333333)");
  });

  it("treats casing-only title differences as the same mention token", () => {
    const items = buildThreadMentionComposerItems({
      projects,
      currentThreadId: null,
      query: "release",
      threads: [
        thread({ id: "thread-aaaaaa", projectId: "project", title: "Release" }),
        thread({ id: "thread-bbbbbb", projectId: "project", title: "release" }),
      ],
    });

    const names = items.map((item) => (item.type === "thread" ? item.mention.name : ""));
    expect(names).toEqual(["Release (aaaaaa)", "release (bbbbbb)"]);
  });
});

describe("resolveThreadMentionForThreadId", () => {
  const projects = [project("project", "project", "Moss"), project("other", "project", "Other")];
  const threads = [
    thread({ id: "current", projectId: "project", title: "Current" }),
    thread({ id: "dup-a", projectId: "project", title: "Release" }),
    thread({ id: "dup-b", projectId: "other", title: "Release" }),
    thread({ id: "archived", projectId: "project", title: "Old", archivedAt: "2026-01-02" }),
  ];

  it("resolves the same disambiguated mention the @ menu inserts", () => {
    const menuItem = buildThreadMentionComposerItems({
      projects,
      threads,
      currentThreadId: "current",
      query: "",
    }).find((item) => item.id === "thread:dup-b");

    expect(
      resolveThreadMentionForThreadId({
        projects,
        threads,
        currentThreadId: "current",
        threadId: "dup-b",
      }),
    ).toEqual({ name: "Release (Other)", path: "thread://dup-b" });
    expect(menuItem?.type === "thread" ? menuItem.mention.name : null).toBe("Release (Other)");
  });

  it("returns null for the current, archived, or unknown chat", () => {
    for (const threadId of ["current", "archived", "missing"]) {
      expect(
        resolveThreadMentionForThreadId({
          projects,
          threads,
          currentThreadId: "current",
          threadId,
        }),
      ).toBeNull();
    }
  });
});

function slashItemSource(id: string): string {
  return id.slice(0, id.indexOf(":"));
}

describe("useComposerCommandMenuItems slash commands", () => {
  function slashItems(query: string) {
    return useComposerCommandMenuItems({
      composerTrigger: { kind: "slash-command", query, rangeStart: 0, rangeEnd: query.length + 1 },
      provider: "claudeAgent",
      providerPlugins: [],
      providerNativeCommands: [
        { name: "design", description: "Make a new Design artifact from a brief" },
        { name: "dataviz", description: "Use this skill whenever you are about to chart data" },
      ],
      providerSkills: [
        {
          name: "deploy-preview",
          description: "Ship a preview build",
          path: "/skills/deploy-preview",
          enabled: true,
        },
      ],
      workspaceEntries: [],
      searchableModelOptions: [],
      supportsFastSlashCommand: false,
      canOfferCompactCommand: false,
      canOfferReviewCommand: false,
      canOfferForkCommand: false,
      canOfferSideCommand: false,
      canOfferExportCommand: false,
      dynamicAgents: [],
    }).map((item) => item.id);
  }

  it("lists Moss commands, then the provider's, then skills when nothing is typed", () => {
    const ids = slashItems("");
    const firstProvider = ids.findIndex((id) => id.startsWith("provider-command:"));
    const firstSkill = ids.findIndex((id) => id.startsWith("skill:"));

    expect(ids[0]?.startsWith("slash:")).toBe(true);
    expect(firstProvider).toBeGreaterThan(0);
    expect(firstSkill).toBeGreaterThan(firstProvider);
    expect(
      ids.slice(firstProvider, firstSkill).every((id) => id.startsWith("provider-command:")),
    ).toBe(true);
  });

  it("leads with the best match across every source", () => {
    const ids = slashItems("design");

    expect(ids[0]).toBe("provider-command:claudeAgent:design");
  });

  it("keeps each source's rows together after ranking", () => {
    const ids = slashItems("de");
    const runs = ids.map(slashItemSource).filter((source, index, all) => source !== all[index - 1]);

    expect(new Set(runs).size).toBe(runs.length);
    expect(ids).toContain("skill:/skills/deploy-preview");
  });
});

describe("devsReportMenuItems", () => {
  it("offers @devs while the mention query is empty or still spells devs", () => {
    for (const query of ["", "d", "de", "dev", "devs", "DEVS"]) {
      expect(devsReportMenuItems(query).map((item) => item.label)).toEqual(["@devs"]);
    }
  });

  it("stays out of the way of every other mention", () => {
    for (const query of ["devin", "devsx", "doc", "x"]) {
      expect(devsReportMenuItems(query)).toEqual([]);
    }
  });
});
