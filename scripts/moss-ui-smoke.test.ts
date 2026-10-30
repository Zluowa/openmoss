import { describe, expect, it } from "vitest";

import {
  buildMossUiSmokePlan,
  runMossUiSmokeCommands,
  type MossUiSmokeCommand,
  type MossUiSmokeSpawn,
} from "./moss-ui-smoke.ts";

describe("moss-ui-smoke", () => {
  it("builds a provider-credential-free Moss UI smoke command plan", () => {
    const plan = buildMossUiSmokePlan();

    expect(plan.version).toBe(1);
    expect(plan.commands.map((command) => command.id)).toEqual([
      "moss-promoted-shell-served-app-smoke",
      "moss-control-plane-browser-smoke",
      "moss-control-plane-unit-smoke",
      "moss-web-typecheck",
    ]);
    expect(plan.commands[0]?.args).toEqual(["scripts/moss-promoted-shell-served-smoke.ts"]);
    expect(plan.commands[1]?.args).toEqual([
      "--filter",
      "@synara/web",
      "test:browser",
      "--",
      "MossControlPlanePanel.browser.tsx",
      "mossNormalizedTimeline.browser.tsx",
    ]);
    expect(plan.commands[2]?.args).toEqual([
      "--filter",
      "@synara/web",
      "test",
      "--",
      "mossNormalizedTimeline",
      "MossControlPlanePanel",
    ]);
    expect(plan.commands[3]?.args).toEqual(["--filter", "@synara/web", "typecheck"]);
  });

  it("stops on the first failing smoke command", () => {
    const commands: MossUiSmokeCommand[] = [
      {
        id: "first",
        description: "first command",
        command: "bun",
        args: ["first"],
      },
      {
        id: "second",
        description: "second command",
        command: "bun",
        args: ["second"],
      },
    ];
    const calls: string[] = [];
    const spawn: MossUiSmokeSpawn = (_command, args) => {
      calls.push(args.join(" "));
      return { status: calls.length === 1 ? 7 : 0 };
    };

    expect(runMossUiSmokeCommands(commands, spawn)).toBe(7);
    expect(calls).toEqual(["first"]);
  });

  it("returns pass when every smoke command succeeds", () => {
    const calls: string[] = [];
    const spawn: MossUiSmokeSpawn = (command, args) => {
      calls.push([command, ...args].join(" "));
      return { status: 0 };
    };

    expect(runMossUiSmokeCommands(buildMossUiSmokePlan().commands, spawn)).toBe(0);
    expect(calls).toHaveLength(4);
  });
});
