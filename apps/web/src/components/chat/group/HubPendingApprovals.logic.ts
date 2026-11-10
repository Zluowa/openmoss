// Whether the coordinator composer may show worker approval cards.
// Only Mossbot conversations mount these now; the Hubs surface was removed (2026-11-10).

export function shouldShowHubPendingApprovals(input: {
  readonly groupsOn: boolean;
  readonly isCoordinatorConversation: boolean;
  readonly hasActiveThread: boolean;
}): boolean {
  return input.groupsOn && input.isCoordinatorConversation && input.hasActiveThread;
}
