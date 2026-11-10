import { describe, expect, it } from "vitest";

import {
  defaultExternalMcpConnectionName,
  describeExternalMcpPermissions,
} from "./externalMcpSetup";
import { fallbackMossPlanName } from "../SidebarAccountMenu";

describe("external agent connection defaults", () => {
  it("names a new connection in the person's language", () => {
    expect(defaultExternalMcpConnectionName("zh-CN")).toBe("编程智能体");
    expect(defaultExternalMcpConnectionName("en")).toBe("Coding agent");
  });

  it("describes computer control without naming a Mac", () => {
    expect(describeExternalMcpPermissions(["computer:control"])).not.toMatch(/Mac/);
  });
});

describe("account menu plan name", () => {
  it("shows a plan name instead of the raw plan code", () => {
    expect(fallbackMossPlanName("enterprise")).toBe("Enterprise");
    expect(fallbackMossPlanName("free")).toBe("Free");
    expect(fallbackMossPlanName("custom-plan")).toBe("custom-plan");
  });
});
