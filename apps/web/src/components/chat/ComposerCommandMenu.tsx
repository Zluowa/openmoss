import {
  type ProjectEntry,
  type ModelSlug,
  type ProviderNativeCommandDescriptor,
  type ProviderMentionReference,
  type ProviderInstanceId,
  type ProviderKind,
  type ProviderPluginDescriptor,
  type ProviderSkillDescriptor,
} from "@moss/contracts";
import { type ReactNode } from "react";
import { type ComposerTriggerKind } from "../../composer-logic";
import { type ComposerSlashCommand } from "../../composerSlashCommands";
import {
  BotIcon,
  BrainIcon,
  BugReportIcon,
  ChangesIcon,
  CircleAlertIcon,
  DeviceLaptopIcon,
  GitBranchIcon,
  type LucideIcon,
  PluginIcon,
  SkillCubeIcon,
  TerminalIcon,
  WorktreeIcon,
} from "~/lib/icons";
import { type ProviderCommandNotice } from "~/lib/claudeArtifactCommands";
import { slashCommandIcon } from "~/lib/slashCommandIcons";
import { formatSkillScope } from "~/lib/providerDiscovery";
import { cn } from "~/lib/utils";
import { FileEntryIcon } from "./FileEntryIcon";
import { ProviderIcon } from "../ProviderIcon";
import { ConnectorIcon } from "../ConnectorIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  COMPOSER_MENU_PANEL_GLYPH_CLASS_NAME,
  COMPOSER_MENU_PANEL_GROUP_LABEL_CLASS_NAME,
  ComposerMenuPanel,
  type ComposerMenuPanelGroup,
  type ComposerMenuPanelKeyHint,
} from "./ComposerMenuPanel";
import { groupCommandItems } from "./composerCommandGroups";

function humanizeProviderCommandName(command: string): string {
  return command
    .split(/[-_]/g)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function commandMenuTitle(
  item: Extract<ComposerCommandItem, { type: "slash-command" | "provider-native-command" }>,
): string {
  switch (item.command) {
    case "clear":
      return "Clear";
    case "compact":
      return "Compact Context";
    case "model":
      return "Model";
    case "fast":
      return "Fast Mode";
    case "plan":
      return "Plan Mode";
    case "debug":
      return "Debug Mode";
    case "default":
      return "Default Mode";
    case "review":
      return "Code Review";
    case "fork":
      return "Fork";
    case "side":
      return "Sidechat";
    case "status":
      return "Status";
    case "subagents":
      return "Subagents";
    case "feedback":
      return "Feedback Moss";
    default:
      return humanizeProviderCommandName(item.command);
  }
}

function commandMenuTrailingMeta(item: ComposerCommandItem): string | null {
  if (item.type === "agent") {
    return "delegate task to subagent";
  }

  if (item.type === "plugin") {
    return "Plugin";
  }

  if (item.type === "connector") {
    return "Connector";
  }

  if (item.type === "thread") {
    return null;
  }

  if (item.type === "local-root") {
    return "Local";
  }

  if (item.type === "skill") {
    return formatSkillScope(item.skill.scope);
  }

  if (item.type === "model") {
    return "Model";
  }

  if (item.type === "slash-command" || item.type === "provider-native-command") {
    return `/${item.command}`;
  }

  // Right-align the parent path so many same-named entries (e.g. worktrees) stay
  // distinguishable without crowding the name column.
  if (item.type === "path") {
    return item.description.length > 0 ? item.description : null;
  }

  return null;
}

function commandMenuSecondaryText(item: ComposerCommandItem): string | null {
  // The menu is driven from the composer, so focus never reaches the warning icon:
  // the row itself has to say why the command will not work.
  if (item.type === "provider-native-command" && item.notice) {
    return item.notice.summary;
  }

  if (item.type === "slash-command" || item.type === "provider-native-command") {
    return item.description;
  }

  if (item.type === "agent") {
    return item.description;
  }

  if (
    item.type === "plugin" ||
    item.type === "connector" ||
    item.type === "skill" ||
    item.type === "local-root" ||
    item.type === "thread" ||
    item.type === "devs-report"
  ) {
    return item.description;
  }

  return null;
}

export type ComposerCommandItem =
  | {
      id: string;
      type: "path";
      path: string;
      pathKind: ProjectEntry["kind"];
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "local-root";
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "slash-command";
      command: ComposerSlashCommand;
      label: string;
      description: string;
      source: "app" | "shared";
    }
  | {
      id: string;
      type: "provider-native-command";
      provider: ProviderKind;
      command: ProviderNativeCommandDescriptor["name"];
      label: string;
      description: string;
      /** Why the command cannot fully work right now: row text plus a warning tooltip. */
      notice?: ProviderCommandNotice | null;
    }
  | {
      id: string;
      type: "fork-target";
      target: "local" | "worktree";
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "review-target";
      target: "changes" | "base-branch";
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "model";
      provider: ProviderKind;
      instanceId: ProviderInstanceId;
      model: ModelSlug;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "plugin";
      plugin: ProviderPluginDescriptor;
      mention: ProviderMentionReference;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "thread";
      threadId: string;
      provider: ProviderKind;
      mention: ProviderMentionReference;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "connector";
      /** Display name, also what picks the brand mark or favicon. */
      connectorName: string;
      mention: ProviderMentionReference;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "skill";
      skill: ProviderSkillDescriptor;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "agent";
      provider: ProviderKind;
      alias: string;
      color: string;
      label: string;
      description: string;
    }
  | {
      // `@devs`: reports a problem to the Moss developers instead of starting a turn.
      id: string;
      type: "devs-report";
      label: string;
      description: string;
    };

function composerCommandMenuEnterLabel(triggerKind: ComposerTriggerKind | null): string {
  switch (triggerKind) {
    case "slash-command":
      return "Run";
    case "slash-model":
      return "Select";
    default:
      return "Insert";
  }
}

export function composerCommandMenuKeyHints(input: {
  triggerKind: ComposerTriggerKind | null;
  hasItems: boolean;
  escapeClosesMenu: boolean;
}): ComposerMenuPanelKeyHint[] {
  const hints: ComposerMenuPanelKeyHint[] = input.hasItems
    ? [
        { keys: ["↑", "↓"], label: "Navigate" },
        { keys: ["↵"], label: composerCommandMenuEnterLabel(input.triggerKind) },
      ]
    : [];
  if (input.escapeClosesMenu) {
    hints.push({ keys: ["esc"], label: "Close" });
  }
  return hints;
}

function CommandNoticeBadge(props: { notice: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span role="img" aria-label={props.notice} className="inline-flex items-center" />}
      >
        <CircleAlertIcon className="size-4 text-warning" />
      </TooltipTrigger>
      <TooltipPopup
        side="top"
        align="end"
        className="max-w-72 whitespace-normal text-ui-sm leading-snug"
      >
        {props.notice}
      </TooltipPopup>
    </Tooltip>
  );
}

export function ComposerCommandMenu(props: {
  items: ComposerCommandItem[];
  resolvedTheme: "light" | "dark";
  isLoading: boolean;
  triggerKind: ComposerTriggerKind | null;
  groupSlashCommandSections?: boolean;
  emptyStateText?: string;
  /** False where Escape belongs to the surrounding surface (a dialog) instead of the menu. */
  escapeClosesMenu?: boolean;
  activeItemId: string | null;
  onHighlightedItemChange: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const keyHints = composerCommandMenuKeyHints({
    triggerKind: props.triggerKind,
    hasItems: props.items.length > 0,
    escapeClosesMenu: props.escapeClosesMenu ?? true,
  });
  const groups = groupCommandItems(
    props.items,
    props.triggerKind,
    props.groupSlashCommandSections ?? true,
  );
  const panelGroups: ComposerMenuPanelGroup[] = groups.map((group) => ({
    id: group.id,
    label: group.label,
    rows: group.items.map((item) => ({
      id: item.id,
      icon: commandMenuItemGlyph(item, props.resolvedTheme),
      title:
        item.type === "slash-command" || item.type === "provider-native-command"
          ? commandMenuTitle(item)
          : item.label,
      secondary: commandMenuSecondaryText(item),
      trailing:
        item.type === "provider-native-command" && item.notice ? (
          <span className="inline-flex items-center gap-1.5">
            {commandMenuTrailingMeta(item)}
            <CommandNoticeBadge notice={item.notice.detail} />
          </span>
        ) : (
          commandMenuTrailingMeta(item)
        ),
    })),
  }));
  const itemsById = new Map(props.items.map((item) => [item.id, item]));

  return (
    <ComposerMenuPanel
      groups={panelGroups}
      activeRowId={props.activeItemId}
      onHighlightRow={props.onHighlightedItemChange}
      onSelectRow={(rowId) => {
        const item = itemsById.get(rowId);
        if (item) props.onSelect(item);
      }}
      keyHints={keyHints}
      footer={
        props.triggerKind === "mention" ? (
          /* This footer is informational copy, not a selectable result group. */
          <div className="pt-0.5 pb-2">
            <p
              className={cn(
                COMPOSER_MENU_PANEL_GROUP_LABEL_CLASS_NAME,
                "px-2 py-0 font-medium text-muted-foreground text-ui leading-snug",
              )}
            >
              Files
            </p>
            <p className="px-2 pt-0.5 text-ui-sm text-muted-foreground/55">
              Type to search for files
            </p>
          </div>
        ) : null
      }
      status={
        props.items.length === 0 ? (
          <p
            className={cn(
              "text-muted-foreground/50 text-ui-sm",
              props.isLoading
                ? "flex h-[calc(1.625rem+0.5rem)] items-center px-2 text-left"
                : "px-2 py-1.5",
            )}
          >
            {props.isLoading
              ? props.triggerKind === "mention"
                ? "Searching mentions..."
                : props.triggerKind === "skill"
                  ? "Loading skills..."
                  : "Loading commands..."
              : (props.emptyStateText ??
                (props.triggerKind === "mention"
                  ? "No matching plugin, chat, or file."
                  : props.triggerKind === "skill"
                    ? "No matching skill."
                    : "No matching command."))}
          </p>
        ) : null
      }
    />
  );
}

// Files mirror the recap / diff changed-files treatment (FileEntryIcon at
// size-4 with the same dimmed foreground) so a file reads identically whether
// it appears in a turn summary or in the composer.
const COMPOSER_COMMAND_ITEM_FILE_ICON_CLASSNAME =
  "size-4 text-[var(--color-text-foreground)] opacity-70 dark:opacity-80";

const COMPOSER_COMMAND_ITEM_GLYPH_CLASSNAME = COMPOSER_MENU_PANEL_GLYPH_CLASS_NAME;

function commandMenuSlashGlyph(command: string, fallback: LucideIcon): ReactNode {
  const Icon = slashCommandIcon(command, fallback);
  return <Icon className={COMPOSER_COMMAND_ITEM_GLYPH_CLASSNAME} />;
}

function commandMenuItemGlyph(item: ComposerCommandItem, theme: "light" | "dark"): ReactNode {
  const cls = COMPOSER_COMMAND_ITEM_GLYPH_CLASSNAME;
  switch (item.type) {
    case "path":
      return (
        <FileEntryIcon
          pathValue={item.path}
          kind={item.pathKind}
          theme={theme}
          className={
            item.pathKind === "directory" ? cls : COMPOSER_COMMAND_ITEM_FILE_ICON_CLASSNAME
          }
        />
      );
    case "local-root":
      return <DeviceLaptopIcon className={cls} />;
    case "fork-target":
      return item.target === "local" ? (
        <DeviceLaptopIcon className={cls} />
      ) : (
        <WorktreeIcon className={cls} />
      );
    case "review-target":
      return item.target === "changes" ? (
        <ChangesIcon className={cls} />
      ) : (
        <GitBranchIcon className={cls} />
      );
    case "slash-command":
      return commandMenuSlashGlyph(item.command, TerminalIcon);
    case "provider-native-command":
      // Provider native commands surface skills (e.g. Claude exposes skills as
      // slash commands), so default to the skill block glyph used for skill
      // tokens in the composer/timeline — named commands still keep their icon.
      return commandMenuSlashGlyph(item.command, SkillCubeIcon);
    case "model":
      return <BrainIcon className={cls} />;
    case "agent":
      return <BotIcon className={cls} />;
    case "plugin":
      return <PluginIcon className={cls} />;
    case "thread":
      return <ProviderIcon provider={item.provider} className={cls} />;
    case "connector":
      return <ConnectorIcon name={item.connectorName} className={cls} />;
    case "skill":
      return <SkillCubeIcon className={cls} />;
    case "devs-report":
      return <BugReportIcon className={cls} />;
    default:
      return null;
  }
}
