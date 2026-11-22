// FILE: MossKineticIcon.test.tsx
// Purpose: Verifies all 20 Moss Kinetic Icons, SVG attributes, clipPath uniqueness, 400-pair morph frames, and work-entry icon resolution.
// Layer: Web UI unit tests

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ArrowUpCircleIcon,
  BackgroundTrayIcon,
  BookOpenIcon,
  BotIcon,
  BrainIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleQuestionIcon,
  ClockIcon,
  CloudSyncIcon,
  CompassLineIcon,
  ComputerUseIcon,
  ContextCompactionIcon,
  EyeIcon,
  FileIcon,
  FolderIcon,
  GitBranchIcon,
  GitHubIcon,
  GitPullRequestIcon,
  GlobeIcon,
  HammerIcon,
  HandoffIcon,
  HistoryIcon,
  ImageIcon,
  type LucideIcon,
  McpIcon,
  PencilIcon,
  PluginIcon,
  SearchIcon,
  SkillCubeIcon,
  TerminalIcon,
  WebSearchIcon,
  ZapIcon,
} from "~/lib/icons";
import type { WorkLogEntry } from "~/workLog";
import { MOSS_KINETIC_ICON_IDS } from "./kineticIconDefinitions";
import { buildKineticTransitionFrame } from "./kineticTransitionEngine";
import { MossKineticIcon } from "./MossKineticIcon";
import { resolveWorkEntryKineticIcon } from "./workEntryKineticIcon";

function makeWorkEntry(overrides: Partial<WorkLogEntry> = {}): WorkLogEntry {
  return {
    id: "work-1",
    createdAt: "2026-11-23T00:00:00.000Z",
    label: "Tool call",
    tone: "tool",
    ...overrides,
  };
}

describe("MossKineticIcon", () => {
  it("renders all 20 icons with uniform 24x24 1.5px outline attributes and no sub-1.35px stroke widths", () => {
    for (const id of MOSS_KINETIC_ICON_IDS) {
      const markup = renderToStaticMarkup(<MossKineticIcon name={id} active={false} />);
      expect(markup).toContain('viewBox="0 0 24 24"');
      expect(markup).toContain('fill="none"');
      expect(markup).toContain('stroke="currentColor"');
      expect(markup).toContain('stroke-width="1.5"');
      expect(markup).toContain('data-slot="moss-kinetic-icon"');
      expect(markup).toContain(`data-kinetic-icon="${id}"`);
      expect(markup).toContain('data-active="false"');

      const strokeWidths = [...markup.matchAll(/stroke-width="([^"]+)"/g)].map((m) =>
        Number.parseFloat(m[1]!),
      );
      for (const width of strokeWidths) {
        expect(width).toBeGreaterThanOrEqual(1.35);
        expect(width).toBeLessThanOrEqual(1.5);
      }
    }
  });

  it("toggles data-active between running and settled states", () => {
    const runningMarkup = renderToStaticMarkup(<MossKineticIcon name="terminal" active />);
    const settledMarkup = renderToStaticMarkup(<MossKineticIcon name="terminal" active={false} />);

    expect(runningMarkup).toContain('data-active="true"');
    expect(settledMarkup).toContain('data-active="false"');
  });

  it("generates unique clipPath ids and valid references across duplicate concurrent renders", () => {
    const combinedMarkup = renderToStaticMarkup(
      <>
        {MOSS_KINETIC_ICON_IDS.map((id) => (
          <MossKineticIcon key={`a-${id}`} name={id} active />
        ))}
        {MOSS_KINETIC_ICON_IDS.map((id) => (
          <MossKineticIcon key={`b-${id}`} name={id} active={false} />
        ))}
      </>,
    );

    const clipIds = [...combinedMarkup.matchAll(/<clipPath id="([^"]+)"/g)].map((m) => m[1]!);
    expect(clipIds.length).toBeGreaterThanOrEqual(12);
    expect(new Set(clipIds).size).toBe(clipIds.length);

    const clipSet = new Set(clipIds);
    const clipRefs = [...combinedMarkup.matchAll(/clip-path="url\(#([^)]+)\)"/g)].map((m) => m[1]!);
    expect(clipRefs.length).toBeGreaterThanOrEqual(12);
    for (const refId of clipRefs) {
      expect(clipSet.has(refId)).toBe(true);
    }
  });

  it("computes valid finite SVG morph layers across all 400 (from, to) icon pairs", () => {
    const sampleTimes = [0, 0.35, 0.5, 0.75, 1] as const;

    for (const fromId of MOSS_KINETIC_ICON_IDS) {
      for (const toId of MOSS_KINETIC_ICON_IDS) {
        for (const t of sampleTimes) {
          const frame = buildKineticTransitionFrame(fromId, toId, t);
          expect(frame.viewBox).toBe("0 0 24 24");
          expect(frame.groups.length).toBeGreaterThan(0);

          const totalPaths = frame.groups.reduce((sum, group) => sum + group.paths.length, 0);
          expect(totalPaths).toBeGreaterThan(0);

          for (const group of frame.groups) {
            expect(group.transform?.includes("NaN") ?? false).toBe(false);
            if (group.opacity !== undefined) {
              expect(Number.isFinite(group.opacity)).toBe(true);
            }
            for (const layer of group.paths) {
              expect(layer.d.length).toBeGreaterThan(0);
              expect(layer.d.includes("NaN")).toBe(false);
              expect(layer.strokeDasharray?.includes("NaN") ?? false).toBe(false);
              expect(layer.strokeDashoffset?.includes("NaN") ?? false).toBe(false);
            }
          }
        }
      }
    }
  });
});

const CustomBrandWrapper: LucideIcon = () => null;

describe("resolveWorkEntryKineticIcon", () => {
  it("maps all 20 kinetic icon categories from tool metadata and outline icons", () => {
    const cases: Array<
      readonly [WorkLogEntry, LucideIcon, (typeof MOSS_KINETIC_ICON_IDS)[number]]
    > = [
      [makeWorkEntry({ requestKind: "file-read" }), FileIcon, "reading"],
      [makeWorkEntry({}), BookOpenIcon, "book"],
      [makeWorkEntry({ itemType: "command_execution" }), TerminalIcon, "terminal"],
      [makeWorkEntry({ toolName: "grep" }), SearchIcon, "search"],
      [makeWorkEntry({ requestKind: "file-change" }), PencilIcon, "editing"],
      [makeWorkEntry({}), BrainIcon, "thinking"],
      [makeWorkEntry({ itemType: "collab_agent_tool_call" }), BotIcon, "mossbot"],
      [makeWorkEntry({ toolName: "write_file" }), SkillCubeIcon, "skills"],
      [makeWorkEntry({ toolName: "load_plugin" }), PluginIcon, "plugins"],
      [makeWorkEntry({ toolName: "list_mcp" }), McpIcon, "plugins"],
      [makeWorkEntry({}), GitBranchIcon, "branch"],
      [makeWorkEntry({}), GitPullRequestIcon, "pull-request"],
      [makeWorkEntry({ itemType: "web_search" }), WebSearchIcon, "browser"],
      [makeWorkEntry({}), GlobeIcon, "browser"],
      [makeWorkEntry({}), ClockIcon, "automations"],
      [makeWorkEntry({}), FolderIcon, "library"],
      [makeWorkEntry({ itemType: "image_generation" }), ZapIcon, "images"],
      [makeWorkEntry({}), ImageIcon, "images"],
      [makeWorkEntry({}), CloudSyncIcon, "cloud-sync"],
      [makeWorkEntry({ toolName: "computer_click" }), ComputerUseIcon, "computer"],
      [makeWorkEntry({ toolName: "deep_research" }), HammerIcon, "deep-research"],
      [makeWorkEntry({ itemType: "image_view" }), EyeIcon, "vision-scan"],
      [makeWorkEntry({}), CompassLineIcon, "navigate"],
    ];

    for (const [entry, icon, expected] of cases) {
      expect(resolveWorkEntryKineticIcon(entry, icon)).toBe(expected);
    }
  });

  it("keeps excluded status/brand icons and custom wrappers unswapped", () => {
    const excluded: LucideIcon[] = [
      GitHubIcon,
      CircleAlertIcon,
      CheckIcon,
      CircleQuestionIcon,
      ArrowUpCircleIcon,
      ContextCompactionIcon,
      BackgroundTrayIcon,
      HandoffIcon,
      HistoryIcon,
    ];
    for (const icon of excluded) {
      expect(resolveWorkEntryKineticIcon(makeWorkEntry(), icon)).toBeNull();
    }

    expect(
      resolveWorkEntryKineticIcon(makeWorkEntry({ toolName: "plugin_hub" }), CustomBrandWrapper),
    ).toBeNull();
    expect(
      resolveWorkEntryKineticIcon(makeWorkEntry({ toolName: "zap_misc" }), ZapIcon),
    ).toBeNull();
  });
});
