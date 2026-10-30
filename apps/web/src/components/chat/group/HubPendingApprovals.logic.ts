// Whether the coordinator composer may show worker approval cards.
// Hubs stay behind the Beta gate: Stable (GROUPS_ON false) never mounts them.

export function shouldShowHubPendingApprovals(input: {
  readonly groupsOn: boolean;
  readonly isCoordinatorConversation: boolean;
  readonly hasActiveThread: boolean;
}): boolean {
  return input.groupsOn && input.isCoordinatorConversation && input.hasActiveThread;
}
