import { describe, expect, it } from "vitest";

import { MOSSBOT_KID_TONES, type MossbotKidTone } from "~/theme/mossbotKid";
import type { MossbotCompanionState } from "../MossbotCompanion";
import {
  MOSSBOT_KID_CLIPS,
  MOSSBOT_KID_TICKS_PER_SECOND,
  mossbotKidBridge,
  mossbotKidClip,
  mossbotKidClipAfter,
  mossbotKidClipFor,
  mossbotKidClipTicks,
  mossbotKidSceneFor,
  sampleMossbotKidClip,
} from "./mossbotKidClips";
import { mossbotPinwheelPixels } from "./mossbotPinwheel";
import {
  MOSSBOT_KID_FORM_KEYS,
  MOSSBOT_KID_FORMS,
  MOSSBOT_KID_STAGE,
  mossbotKidPalette,
  mossbotKidPose,
  renderMossbotKidPose,
} from "./mossbotKidSprite";

const tickMs = 1000 / MOSSBOT_KID_TICKS_PER_SECOND;

describe("mossbotPinwheelPixels", () => {
  it("keeps the four blades apart, so the mark never closes into a cross", () => {
    for (const size of [7, 9, 11, 19]) {
      const onCentreLines = mossbotPinwheelPixels(0, size).filter(
        ([dx, dy]) => dx === 0 || dy === 0,
      );
      expect(onCentreLines).toEqual([]);
    }
  });

  it("repeats every quarter turn", () => {
    const still = mossbotPinwheelPixels(0, 11);
    const turned = new Set(still.map(([dx, dy, c]) => `${-dy},${dx},${c}`));
    expect(new Set(still.map(([dx, dy, c]) => `${dx},${dy},${c}`))).toEqual(turned);
    expect(mossbotPinwheelPixels(90, 11)).toBe(still);
    expect(mossbotPinwheelPixels(15.4, 11)).toBe(mossbotPinwheelPixels(15, 11));
  });
});

describe("renderMossbotKidPose", () => {
  it("draws every clip for every body form and tone, standing on the stage", () => {
    for (const form of MOSSBOT_KID_FORM_KEYS) {
      for (const clip of MOSSBOT_KID_CLIPS) {
        for (const frame of [...clip.enter, ...clip.loop]) {
          const grid = renderMossbotKidPose(frame.pose, form);
          expect(grid).toHaveLength(MOSSBOT_KID_STAGE.rows);
          // Still inside its egg, the kid is hidden by the shell.
          if (frame.pose.props.some(([name, step]) => name === "egg" && step < 3)) {
            expect(grid.flat()).toContain("W");
            continue;
          }
          const body = grid.flat().filter((key) => key === "T" || key === "U").length;
          expect(body, `${form} ${clip.id} ${frame.label}`).toBeGreaterThan(20);
        }
      }
      const rest = renderMossbotKidPose(mossbotKidPose(), form);
      expect(rest[MOSSBOT_KID_STAGE.ground]!.some(Boolean), `${form} stands on the ground`).toBe(
        true,
      );
      expect(rest.flat()).toContain("C");
      expect(rest.flat()).toContain(MOSSBOT_KID_FORMS[form].eyeKey);
    }
    for (const tone of Object.keys(MOSSBOT_KID_TONES) as MossbotKidTone[]) {
      const palette = mossbotKidPalette(tone);
      expect(palette.T).toBe(MOSSBOT_KID_TONES[tone].body);
      expect(palette.C).toBe(mossbotKidPalette("moss").C);
    }
  });
});

describe("MOSSBOT_KID_FORMS", () => {
  it("draws every body by hand, mirror-symmetric and of even rows", () => {
    for (const form of MOSSBOT_KID_FORM_KEYS) {
      const rows = MOSSBOT_KID_FORMS[form].rows;
      for (const row of rows) {
        expect(row, form).toHaveLength(rows[0]!.length);
        expect([...row].reverse().join(""), form).toBe(row);
      }
      expect(rows[0]!.length % 2, `${form} has a centre column`).toBe(1);
    }
  });
});

describe("mossbot kid clips", () => {
  it("gives every companion state a clip", () => {
    const states: MossbotCompanionState[] = [
      "idle",
      "spawn",
      "listening",
      "thinking",
      "working",
      "busy",
      "waiting",
      "notify",
      "done",
      "error",
      "sleeping",
      "greeting",
    ];
    for (const state of states) expect(mossbotKidClipFor(state).loop.length).toBeGreaterThan(0);
    expect(mossbotKidClipFor("working").id).toBe("working");
    expect(mossbotKidClipFor("busy").id).toBe("typing");
  });

  it("plays the entrance once and then loops", () => {
    const clip = mossbotKidClipFor("spawn");
    const enter = mossbotKidClipTicks(clip.enter);
    const loop = mossbotKidClipTicks(clip.loop);
    expect(sampleMossbotKidClip(clip, 0).phase).toBe("enter");
    expect(sampleMossbotKidClip(clip, enter * tickMs).phase).toBe("loop");
    expect(sampleMossbotKidClip(clip, (enter + loop) * tickMs)).toEqual(
      sampleMossbotKidClip(clip, enter * tickMs),
    );
  });

  it("holds keyframes when stepped and turns the pinwheel through them when smooth", () => {
    const clip = mossbotKidClipFor("working");
    const start = mossbotKidClipTicks(clip.enter) * tickMs;
    const stepped = sampleMossbotKidClip(clip, start + tickMs / 2);
    expect(stepped.pose.pin).toBe(0);
    const smooth = sampleMossbotKidClip(clip, start + tickMs / 2, { smooth: true });
    expect(smooth.pose.pin).toBeCloseTo(15, 5);
    // 60° to 0° is a 30° step forward, not a 60° turn back.
    const last = sampleMossbotKidClip(clip, start + 2.5 * tickMs, { smooth: true });
    expect(last.pose.pin).toBeCloseTo(75, 5);
  });

  it("keeps long holds still in smooth mode", () => {
    const clip = mossbotKidClipFor("idle");
    const early = sampleMossbotKidClip(clip, 5 * tickMs, { smooth: true });
    expect(early.pose.pin).toBe(0);
    expect(early.offsetY).toBe(0);
  });
});

describe("mossbotKidSceneFor", () => {
  it("follows the live turn", () => {
    expect(mossbotKidSceneFor("thinking")).toBe("thinking");
    expect(mossbotKidSceneFor("replying")).toBe("replying");
    expect(mossbotKidSceneFor("waiting")).toBe("waiting");
    expect(mossbotKidSceneFor("stalled")).toBe("stalled");
    expect(mossbotKidSceneFor("done")).toBe("cheering");
    expect(mossbotKidSceneFor("working")).toBe("working");
  });

  it("acts out the running tool", () => {
    const scene = (tool: Parameters<typeof mossbotKidSceneFor>[1]) =>
      mossbotKidSceneFor("working", tool);
    expect(scene({ itemType: "command_execution", command: "bun run test" })).toBe("command");
    expect(scene({ itemType: "command_execution", command: "rg MossbotAvatar src" })).toBe(
      "search",
    );
    expect(scene({ itemType: "command_execution", command: "cat README.md" })).toBe("reading");
    expect(scene({ itemType: "file_change" })).toBe("typing");
    expect(scene({ itemType: "web_search" })).toBe("search");
    expect(scene({ itemType: "image_generation" })).toBe("drawing");
    expect(scene({ itemType: "image_view" })).toBe("viewing");
    expect(scene({ itemType: "collab_agent_tool_call" })).toBe("delegating");
    expect(scene({ itemType: "dynamic_tool_call", toolName: "Read" })).toBe("reading");
    expect(scene({ itemType: "dynamic_tool_call", toolName: "Edit" })).toBe("typing");
    expect(scene({ itemType: "dynamic_tool_call", toolName: "TodoWrite" })).toBe("notes");
    expect(scene({ itemType: "mcp_tool_call", toolName: "create_issue" })).toBe("tool");
    for (const id of [
      "command",
      "search",
      "reading",
      "typing",
      "drawing",
      "viewing",
      "delegating",
      "notes",
      "tool",
    ]) {
      expect(mossbotKidClip(id).id).toBe(id);
    }
  });
});

describe("mossbotKidBridge", () => {
  const rest = mossbotKidClipFor("idle").loop[0]!.pose;
  const holding = mossbotKidClip("typing").loop[0]!.pose;

  it("spins the pinwheel up between empty-handed scenes", () => {
    const bridge = mossbotKidBridge(rest, mossbotKidClip("thinking"));
    expect(bridge.every((frame) => frame.pose.props.length === 0)).toBe(true);
    const pins = bridge.map((frame) => frame.pose.pin);
    expect(pins).toEqual([...pins].sort((a, b) => a - b));
    expect(bridge.map((frame) => frame.ticks)).toEqual([3, 2, 2, 1, 1]);
  });

  it("hops between scenes that hold something, with a puff where things go and come", () => {
    const bridge = mossbotKidBridge(holding, mossbotKidClip("reading"));
    expect(bridge[0]!.pose.props).toEqual([["poof", 0]]);
    expect(Math.min(...bridge.map((frame) => frame.pose.dy))).toBeLessThan(0);
    expect(bridge.at(-1)!.pose.props.map(([name]) => name)).toEqual(["paper", "poof"]);
  });

  it("startles into an error and blinks into sleep", () => {
    expect(mossbotKidBridge(holding, mossbotKidClip("oops"))[0]!.pose.eyes).toBe("wide");
    expect(mossbotKidBridge(holding, mossbotKidClip("sleep"))[0]!.pose.eyes).toBe("blink");
  });

  it("plays the transition before the next clip's own entrance", () => {
    const next = mossbotKidClip("reading");
    const after = mossbotKidClipAfter(holding, next);
    expect(after.enter.length).toBe(mossbotKidBridge(holding, next).length + next.enter.length);
    expect(after.loop).toBe(next.loop);
  });
});
