// FILE: McpAppBlockView.tsx
// Purpose: What a connector widget block looks like (SPEC §9 = SPEC-ui §1B/§2B), as a pure view
//          of the host's state: the header row 「来自 {server} 的小组件」 + tool title + 14 px
//          chevron, the hide-per-connector and side-panel buttons, the 8 px bordered card that
//          holds the live frame, the docked line, the plain-text fallback, prompts and dialogs.
// Layer: Chat transcript UI
// Exports: McpAppBlockView, McpAppBlockViewProps

import type { CSSProperties, ReactNode, Ref } from "react";

import { ChevronRightIcon, ExpandArrowsIcon, EyeIcon, EyeSlashIcon, Minimize2 } from "~/lib/icons";
import type { McpAppHostDialog, McpAppHostPhase, McpAppHostPrompt } from "~/lib/mcpAppHost";
import { MCP_APP_HEIGHT_TRANSITION } from "~/lib/mcpApps/constants";
import type { McpAppBinding } from "~/lib/mcpApps/contracts";
import type { WorkLogMcpToolResult } from "~/lib/toolCallDetails";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ConversationShimmer } from "./ConversationShimmer";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { McpAppDownloadDialog, McpAppOpenLinkDialog } from "./McpAppDialogs";
import { McpAppPromptCard } from "./McpAppPrompts";
import { McpToolResultDetails } from "./McpToolResultDetails";

const HEADER_ICON_BUTTON_CLASS_NAME =
  "relative text-[var(--color-text-foreground-tertiary)] after:absolute after:-inset-0.5 [&_svg,&_[data-slot=central-icon]]:size-3.5";
/** One text-like button: title, tool title and chevron 3 px apart, no fill, no underline. */
const HEADER_BUTTON_CLASS_NAME =
  "group/tool h-auto min-h-0 max-w-full min-w-0 justify-start gap-0.75 rounded-control-xs px-0 py-0 text-start font-normal text-ui no-underline sm:text-ui [:hover,[data-pressed]]:no-underline [&_svg,&_[data-slot=central-icon]]:mx-0 [&_svg,&_[data-slot=central-icon]]:opacity-100";
/** Claude's `border-alpha-2`: the Moss ink at 10 %. */
const CARD_BORDER_CLASS_NAME =
  "border border-[color-mix(in_srgb,var(--color-text-foreground)_10%,transparent)]";

export interface McpAppBlockViewProps {
  readonly binding: McpAppBinding;
  readonly projection: WorkLogMcpToolResult;
  readonly phase: McpAppHostPhase;
  /** The widget is starting and has not said it is ready (shimmering header). */
  readonly loading: boolean;
  readonly open: boolean;
  readonly hidden: boolean;
  readonly hideOffered: boolean;
  readonly height: number;
  readonly prefersBorder: boolean;
  readonly docked: boolean;
  /** The side panel is open on this widget (else the docked line offers 「显示」). */
  readonly dockShowing: boolean;
  readonly canOpenPane: boolean;
  readonly prompt: McpAppHostPrompt | null;
  readonly dialog: McpAppHostDialog | null;
  readonly reducedMotion: boolean;
  readonly frameRef?: Ref<HTMLDivElement> | undefined;
  /** Rendered inside the card; the live frame is laid over it instead. Tests put a stand-in here. */
  readonly frameSlot?: ReactNode;
  readonly overlay?: ReactNode;
  readonly onToggle: () => void;
  readonly onToggleHidden: () => void;
  readonly onOpenPane: () => void;
  readonly onDockAction: () => void;
  readonly onPromptAnswer: (answer: boolean) => void;
  readonly onConnect: () => void;
  readonly onDialogAnswer: (answer: { dontAskAgain: boolean } | boolean | null) => void;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}

export function McpAppBlockView(props: McpAppBlockViewProps) {
  const { t, format } = useTranslation();
  const { binding, phase, open, hidden, docked } = props;
  const fallback = phase === "failed" || phase === "browser_unavailable";
  const initializing = props.loading;
  const promptWaiting = props.prompt !== null;
  const serverName = binding.isFirstParty ? "Moss" : binding.serverLabel;
  const title = initializing
    ? format("mcpApp.title.rendering", { server: serverName })
    : binding.isFirstParty
      ? t("mcpApp.title.firstParty")
      : format("mcpApp.title.widgetFrom", { server: serverName });

  const showCard = open && !fallback && !docked;
  const cardHeight = showCard ? props.height : 0;
  const cardStyle: CSSProperties = {
    height: `${cardHeight}px`,
    transition: props.reducedMotion ? "none" : MCP_APP_HEIGHT_TRANSITION,
  };
  const bordered = props.prefersBorder && cardHeight > 0;

  return (
    <div
      className="flex w-full min-w-0 flex-col"
      data-mcp-app-card="true"
      data-mcp-app-phase={phase}
      data-mcp-app-open={open ? "true" : "false"}
      data-mcp-app-hidden-connector={hidden ? "true" : undefined}
      data-mcp-app-display-mode={docked ? "fullscreen" : "inline"}
    >
      {props.overlay}
      <div className="flex h-6 min-w-0 items-center gap-2">
        <Button
          variant="link"
          type="button"
          aria-expanded={open}
          onClick={props.onToggle}
          className={cn(
            HEADER_BUTTON_CLASS_NAME,
            open
              ? "text-muted-foreground"
              : "text-[var(--color-text-foreground-tertiary)] hover:text-muted-foreground focus-visible:text-muted-foreground",
          )}
          data-mcp-app-header="true"
        >
          <ConversationShimmer active={initializing} className="shrink-0">
            {title}
          </ConversationShimmer>
          {binding.toolTitle ? (
            <span className={cn("min-w-0 truncate", open && "text-foreground")}>
              {binding.toolTitle}
            </span>
          ) : null}
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 transition-transform duration-[60ms]",
              open && "rotate-90",
              props.reducedMotion && "transition-none",
            )}
          />
        </Button>
        <span className="relative flex h-[1lh] shrink-0 items-center gap-2 text-ui">
          {props.hideOffered ? (
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />} disabled={!promptWaiting}>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className={HEADER_ICON_BUTTON_CLASS_NAME}
                  aria-label={hidden ? t("mcpApp.showConnector") : t("mcpApp.hideConnector")}
                  title=""
                  disabled={promptWaiting}
                  data-mcp-app-hide-toggle={hidden ? "show" : "hide"}
                  onClick={props.onToggleHidden}
                >
                  {hidden ? <EyeIcon aria-hidden="true" /> : <EyeSlashIcon aria-hidden="true" />}
                </Button>
              </TooltipTrigger>
              {promptWaiting ? <TooltipPopup>{t("mcpApp.answerFirst")}</TooltipPopup> : null}
            </Tooltip>
          ) : null}
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(HEADER_ICON_BUTTON_CLASS_NAME, !props.canOpenPane && "invisible")}
            aria-label={t("mcpApp.openInPane")}
            title=""
            tabIndex={props.canOpenPane ? undefined : -1}
            aria-hidden={props.canOpenPane ? undefined : true}
            data-mcp-app-open-pane="true"
            onClick={props.onOpenPane}
          >
            <ExpandArrowsIcon aria-hidden="true" />
          </Button>
        </span>
      </div>

      {props.prompt ? (
        <McpAppPromptCard
          prompt={props.prompt}
          serverLabel={binding.serverLabel}
          onAnswer={props.onPromptAnswer}
          onConnect={props.onConnect}
        />
      ) : null}

      {open && docked ? (
        <div
          className="flex items-center gap-2 text-ui-sm text-[var(--color-text-foreground-tertiary)]"
          data-mcp-app-docked-row="true"
        >
          <span role="status">{t("mcpApp.showingInPane")}</span>
          <Button
            variant="ghost"
            size="xs"
            onClick={props.onDockAction}
            data-mcp-app-docked-action={props.dockShowing ? "show-here" : "show"}
          >
            {props.dockShowing ? (
              <Minimize2 aria-hidden="true" />
            ) : (
              <ExpandArrowsIcon aria-hidden="true" />
            )}
            {props.dockShowing ? t("mcpApp.showHere") : t("mcpApp.show")}
          </Button>
        </div>
      ) : null}

      <div
        ref={props.frameRef}
        className={cn(
          "relative w-full min-w-0 overflow-hidden rounded-row",
          bordered ? CARD_BORDER_CLASS_NAME : "border-0",
          !showCard && "pointer-events-none",
        )}
        style={cardStyle}
        aria-busy={initializing}
        aria-hidden={!showCard}
        aria-label={showCard ? title : undefined}
        data-mcp-app-frame="true"
        data-mcp-app-border={bordered ? "true" : undefined}
      >
        {showCard ? props.frameSlot : null}
      </div>

      {open && fallback ? (
        <div className="flex min-w-0 flex-col gap-1" data-mcp-app-fallback="true">
          <div className="min-w-0 max-w-full">
            <McpToolResultDetails
              result={props.projection}
              {...(props.onImageExpand ? { onImageExpand: props.onImageExpand } : {})}
            />
          </div>
          <p className="block ps-1 text-ui-sm text-muted-foreground" data-mcp-app-footnote="true">
            {phase === "browser_unavailable" ? t("mcpApp.desktopOnly") : t("mcpApp.fallbackNote")}
          </p>
        </div>
      ) : null}

      {props.dialog?.kind === "open_link" ? (
        <McpAppOpenLinkDialog plan={props.dialog.plan} onAnswer={props.onDialogAnswer} />
      ) : null}
      {props.dialog?.kind === "download" ? (
        <McpAppDownloadDialog items={props.dialog.items} onAnswer={props.onDialogAnswer} />
      ) : null}
    </div>
  );
}
