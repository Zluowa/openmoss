// FILE: heliosSidebarFixtures.ts
// Purpose: Keep the opt-in Helios sidebar capture fixture deterministic without
//          persisting synthetic projects or threads into a user's Moss profile.
// Layer: Web-only visual verification fixture
// Exports: Helios fixture query parser and thread factory

import type { ModelSelection, ProjectId } from "@synara/contracts";

import type { SidebarThreadSummary } from "~/types";

export const HELIOS_SIDEBAR_FIXTURE_QUERY = "heliosFixture";
export const HELIOS_SIDEBAR_PROJECTS_FIXTURE = "projects";

export function readHeliosSidebarFixtureEnabled(search: string): boolean {
  try {
    return (
      new URLSearchParams(search).get(HELIOS_SIDEBAR_FIXTURE_QUERY) ===
      HELIOS_SIDEBAR_PROJECTS_FIXTURE
    );
  } catch {
    return false;
  }
}

/**
 * Build the child rows used by the Helios 05 capture. These rows are deliberately
 * presentation-only: they never enter the orchestration store, so a capture cannot
 * create fake history in a user's profile. The fixture is appended only when the
 * selected project has no real threads and the caller has explicitly opted in.
 */
export function buildHeliosSidebarFixtureThreads(input: {
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelection;
}): readonly SidebarThreadSummary[] {
  const titles = [
    "/context",
    "Reply exactly CURSOR_FABLE_51",
    "Reply exactly CURSOR_FABLE_51",
    "Reply exactly CURSOR_FABLE_51",
    "Reply exactly CURSOR_FABLE_51",
    "我本地 codex 网络全面报错检查为什么修复",
    "检查并修复 codex",
    "现在需要你逆向反编译 kimiworkflow",
  ];
  const baseTimestamp = Date.parse("2026-09-10T16:53:00.000Z");

  return titles.map((title, index) => {
    const createdAt = new Date(baseTimestamp - index * 60_000).toISOString();
    return {
      id: `helios-sidebar-fixture-thread-${index + 1}` as SidebarThreadSummary["id"],
      projectId: input.projectId,
      title,
      modelSelection: input.modelSelection,
      interactionMode: "default",
      envMode: "local",
      branch: null,
      worktreePath: null,
      session: null,
      createdAt,
      updatedAt: createdAt,
      latestTurn: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      hasLiveTailWork: false,
      pendingBackgroundWorkCount: 0,
      parentThreadId: null,
      forkSourceThreadId: null,
      sidechatSourceThreadId: null,
      sidechatLastActivityAt: null,
      sidechatExpiredAt: null,
      handoff: null,
      lastKnownPr: null,
    } satisfies SidebarThreadSummary;
  });
}
