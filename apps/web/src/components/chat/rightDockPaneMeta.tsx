// FILE: rightDockPaneMeta.tsx
// Purpose: Shared semantic metadata (icon + label) for right-dock pane kinds.
// Layer: Chat right-dock UI primitives
// Exports: per-kind meta map, launcher items, and pane label/icon resolvers.

import type { ReactNode } from "react";

import { basenameOfPath } from "~/file-icons";
import type { LucideIcon } from "~/lib/icons";
import { translateMoss, type TranslationKey } from "~/localization";
import {
  BotIcon,
  DeviceMobileIcon,
  DiffIcon,
  FileIcon,
  FoldersIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  GlobeIcon,
  InfoIcon,
  MessageCircleIcon,
  TerminalIcon,
} from "~/lib/icons";
import { type RightDockPane, type RightDockPaneKind } from "~/rightDockStore.logic";
import { CHAT_SURFACE_CHIP_ICON_CLASS_NAME, SurfaceChipIcon } from "./chatHeaderControls";
import { FileEntryIcon } from "./FileEntryIcon";
import { GeneratedImagePreviewIcon } from "./GeneratedImagePreviewIcon";
import { resolveGeneratedImagePreviewTitle } from "./GeneratedImagePreviewPane";
import { pullRequestPaneTabLabel } from "../pullRequest/pullRequestDetail.logic";

interface RightDockPaneMetaDefinition {
  labelKey: TranslationKey;
  labelOverride?: string;
  Icon: LucideIcon;
}

export interface RightDockPaneMeta extends RightDockPaneMetaDefinition {
  label: string;
}

export interface RightDockLauncherItem extends RightDockPaneMeta {
  kind: RightDockPaneKind;
}

export const RIGHT_DOCK_PANE_META: Record<RightDockPaneKind, RightDockPaneMetaDefinition> = {
  browser: { labelKey: "rightDock.pane.browser", Icon: GlobeIcon },
  device: {
    labelKey: "rightDock.pane.panel",
    labelOverride: "iOS Simulator",
    Icon: DeviceMobileIcon,
  },
  diff: { labelKey: "rightDock.pane.diff", Icon: DiffIcon },
  explorer: { labelKey: "rightDock.pane.files", Icon: FoldersIcon },
  file: { labelKey: "rightDock.pane.file", Icon: FileIcon },
  htmlRender: { labelKey: "rightDock.pane.file", Icon: FileIcon },
  imagePreview: { labelKey: "rightDock.pane.imagePreview", Icon: GeneratedImagePreviewIcon },
  canvas: { labelKey: "chat.generatedImage.preview.canvasView", Icon: GeneratedImagePreviewIcon },
  terminal: { labelKey: "rightDock.pane.terminal", Icon: TerminalIcon },
  sidechat: { labelKey: "rightDock.launcher.sideChats", Icon: MessageCircleIcon },
  subagents: { labelKey: "rightDock.pane.subagents", Icon: BotIcon },
  git: { labelKey: "rightDock.pane.git", Icon: GitCommitIcon },
  pullRequest: { labelKey: "rightDock.pane.pullRequest", Icon: GitPullRequestIcon },
};

// Neutral fallback for any pane kind we no longer recognize (e.g. stale
// persisted state). Persisted dock state is sanitized on rehydrate, so this is
// only a defensive guard to keep a single bad pane from crashing render.
const FALLBACK_RIGHT_DOCK_PANE_META: RightDockPaneMetaDefinition = {
  labelKey: "rightDock.pane.panel",
  Icon: InfoIcon,
};

const DEFAULT_RIGHT_DOCK_TRANSLATOR = (key: TranslationKey): string => translateMoss("en", key);

// Always resolve pane meta through this helper instead of indexing the map
// directly, so an unknown kind degrades gracefully rather than throwing.
export function getRightDockPaneMeta(
  kind: RightDockPaneKind,
  t: (key: TranslationKey) => string = DEFAULT_RIGHT_DOCK_TRANSLATOR,
): RightDockPaneMeta {
  const definition = RIGHT_DOCK_PANE_META[kind] ?? FALLBACK_RIGHT_DOCK_PANE_META;
  return { ...definition, label: definition.labelOverride ?? t(definition.labelKey) };
}

// Codex Desktop's side-panel empty state exposes the three workspace actions in
// this order. Side chats are opened from the conversation affordance and remain
// available to direct callers, but should not displace the Files action in the
// shared "+" menu.
export const RIGHT_DOCK_ADD_MENU_KINDS: readonly RightDockPaneKind[] = [
  "explorer",
  "browser",
  "terminal",
];

/**
 * Keep the header's "+" menu honest when the host already resolved which panes
 * can run in the current workspace. The empty launcher is the source of truth
 * for availability (for example, Files is omitted before a workspace exists),
 * while callers that do not provide launcher metadata retain the legacy direct
 * menu contract used by embedded/test hosts.
 */
export function resolveRightDockAddMenuKinds(
  addMenuKinds: readonly RightDockPaneKind[],
  launcherItems?: readonly RightDockLauncherItem[],
): readonly RightDockPaneKind[] {
  if (!launcherItems) {
    return addMenuKinds;
  }
  const availableKinds = new Set(launcherItems.map((item) => item.kind));
  return addMenuKinds.filter((kind) => availableKinds.has(kind));
}

// Empty-dock launchers prioritize the everyday workspace tools. Review only
// appears when the selected diff scope contains changes, Git is gated by
// repository discovery, and Explorer needs a concrete workspace. Context-only
// file and pull-request panes continue to open from their owning surfaces.
const RIGHT_DOCK_LAUNCHER_ORDER: readonly RightDockPaneKind[] = [
  "diff",
  "terminal",
  "browser",
  "explorer",
  "sidechat",
  "device",
  "git",
];

const RIGHT_DOCK_LAUNCHER_LABEL_KEYS: Partial<Record<RightDockPaneKind, TranslationKey>> = {
  diff: "rightDock.launcher.review",
  explorer: "rightDock.pane.files",
  sidechat: "rightDock.launcher.sideChats",
  git: "rightDock.launcher.sourceControl",
};

const RIGHT_DOCK_PANE_LABEL_KEYS: Record<RightDockPaneKind, TranslationKey> = {
  browser: "rightDock.pane.browser",
  device: "rightDock.pane.panel",
  diff: "rightDock.pane.diff",
  explorer: "rightDock.pane.files",
  file: "rightDock.pane.file",
  htmlRender: "rightDock.pane.file",
  imagePreview: "rightDock.pane.imagePreview",
  canvas: "chat.generatedImage.preview.canvasView",
  terminal: "rightDock.pane.terminal",
  sidechat: "rightDock.pane.sideTask",
  subagents: "rightDock.pane.subagents",
  git: "rightDock.pane.git",
  pullRequest: "rightDock.pane.pullRequest",
};

export function resolveRightDockLauncherItems(
  input: {
    hasWorkspace: boolean;
    hasGitRepository: boolean;
    hasReview: boolean;
    /** True when the local server can host the iOS Simulator pane. */
    hasDeviceSupport?: boolean;
  },
  t: (key: TranslationKey) => string = DEFAULT_RIGHT_DOCK_TRANSLATOR,
): readonly RightDockLauncherItem[] {
  return RIGHT_DOCK_LAUNCHER_ORDER.flatMap((kind) => {
    if (kind === "diff" && !input.hasReview) {
      return [];
    }
    if (kind === "git" && !input.hasGitRepository) {
      return [];
    }
    if (kind === "explorer" && !input.hasWorkspace) {
      return [];
    }
    const meta = getRightDockPaneMeta(kind, t);
    const labelKey = RIGHT_DOCK_LAUNCHER_LABEL_KEYS[kind] ?? RIGHT_DOCK_PANE_LABEL_KEYS[kind];
    if (kind === "device" && input.hasDeviceSupport !== true) {
      return [];
    }
    return [
      {
        kind,
        Icon: meta.Icon,
        label: kind === "device" ? meta.label : t(labelKey),
        labelKey,
      },
    ];
  });
}

// Resolves a tab label, preferring caller-provided per-pane overrides (e.g. the
// embedded sidechat thread title) before falling back to the kind label.
export function resolveRightDockPaneLabel(
  pane: RightDockPane,
  overrides?: Record<string, string | undefined>,
  t: (key: TranslationKey) => string = DEFAULT_RIGHT_DOCK_TRANSLATOR,
): string {
  return overrides?.[pane.id] ?? getRightDockPaneMeta(pane.kind, t).label;
}

export function buildRightDockPaneLabelOverrides(
  panes: readonly RightDockPane[],
  threadSummaries: readonly { id: string; title: string }[],
  formatImagePreviewTitle?: (imageNumber: number) => string,
): Record<string, string | undefined> | undefined {
  const sidechatTitleByThreadId = new Map(
    threadSummaries.map((thread) => [thread.id, thread.title] as const),
  );
  const overrides: Record<string, string | undefined> = {};

  for (const pane of panes) {
    if (pane.kind === "file" && pane.filePath) {
      overrides[pane.id] = basenameOfPath(pane.filePath);
    } else if (pane.kind === "htmlRender" && pane.htmlDocument) {
      overrides[pane.id] = pane.htmlDocument.title;
    } else if (pane.kind === "pullRequest" && pane.pullRequestNumber !== null) {
      overrides[pane.id] = pullRequestPaneTabLabel(pane.pullRequestNumber);
    } else if (pane.kind === "sidechat" && pane.threadId) {
      const title = sidechatTitleByThreadId.get(pane.threadId)?.trim();
      if (title) {
        overrides[pane.id] = title;
      }
    } else if (pane.kind === "imagePreview") {
      overrides[pane.id] = formatImagePreviewTitle
        ? resolveGeneratedImagePreviewTitle(pane, formatImagePreviewTitle)
        : resolveGeneratedImagePreviewTitle(pane);
    }
  }

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

// Resolves a tab glyph: file panes show the per-file-type icon (matching the
// pane header and explorer rows), every other pane uses its kind icon. The file
// glyph inherits the tab's muted foreground color (colorMode="inherit") instead
// of its extension color, so dock tabs read like the changed-file rows rather
// than carrying a loud per-type tint.
export function resolveRightDockPaneIcon(pane: RightDockPane): ReactNode {
  if (pane.kind === "file" && pane.filePath) {
    return (
      <FileEntryIcon
        pathValue={pane.filePath}
        kind="file"
        colorMode="inherit"
        className={CHAT_SURFACE_CHIP_ICON_CLASS_NAME}
      />
    );
  }
  if (pane.kind === "imagePreview") {
    return <GeneratedImagePreviewIcon className={CHAT_SURFACE_CHIP_ICON_CLASS_NAME} />;
  }
  return <SurfaceChipIcon icon={getRightDockPaneMeta(pane.kind).Icon} />;
}
