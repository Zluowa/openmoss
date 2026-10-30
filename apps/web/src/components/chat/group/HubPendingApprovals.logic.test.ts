import { describe, expect, it } from "vitest";

import { shouldShowHubPendingApprovals } from "./HubPendingApprovals.logic";

describe("shouldShowHubPendingApprovals", () => {
  it("stays hidden when Hubs Beta is off, even in a coordinator chat", () => {
    expect(
      shouldShowHubPendingApprovals({
        groupsOn: false,
        isCoordinatorConversation: true,
        hasActiveThread: true,
      }),
    ).toBe(false);
  });

  it("shows cards only for an open coordinator conversation while Hubs Beta is on", () => {
    expect(
      shouldShowHubPendingApprovals({
        groupsOn: true,
        isCoordinatorConversation: true,
        hasActiveThread: true,
      }),
    ).toBe(true);
    expect(
      shouldShowHubPendingApprovals({
        groupsOn: true,
        isCoordinatorConversation: false,
        hasActiveThread: true,
      }),
    ).toBe(false);
    expect(
      shouldShowHubPendingApprovals({
        groupsOn: true,
        isCoordinatorConversation: true,
        hasActiveThread: false,
      }),
    ).toBe(false);
  });
});
