import { describe, expect, it } from "vitest";

import {
  alwaysAllowCandidates,
  buildComputerAppRows,
  nextComputerAppPolicy,
} from "./ComputerAppControls.logic";

const USED = [
  { name: "Notepad" },
  { name: "Settings" },
  { name: "Control Panel" },
  { name: "WeChat" },
];

describe("ComputerAppControls.logic", () => {
  it("never offers Windows Settings or Control Panel as always allowed", () => {
    const rows = buildComputerAppRows(USED, { blockedApps: ["WeChat"], alwaysAllowedApps: [] });
    expect(alwaysAllowCandidates(rows).map((row) => row.name)).toEqual(["Notepad"]);
  });

  it("does not claim an old setting skips the prompt for a never-allowed app", () => {
    const rows = buildComputerAppRows(USED, {
      blockedApps: [],
      alwaysAllowedApps: ["Settings", "Notepad"],
    });
    expect(rows.find((row) => row.name === "Settings")?.alwaysAllowed).toBe(false);
    expect(rows.find((row) => row.name === "Notepad")?.alwaysAllowed).toBe(true);
  });

  it("turning an app off takes it out of always allowed", () => {
    expect(
      nextComputerAppPolicy(
        { blockedApps: [], alwaysAllowedApps: ["Notepad"] },
        { kind: "blocked", app: "notepad", value: true },
      ),
    ).toEqual({ blockedApps: ["notepad"], alwaysAllowedApps: [] });
  });
});
