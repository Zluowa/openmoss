// FILE: ThreadSummaryPanel.tsx
// Purpose: Codex-compatible outputs, background work, and conversation-source summary.
// Layer: Chat shell presentation

import { useId, useRef, useState, type ReactNode } from "react";

import {
  AppsIcon,
  ArrowUpRightIcon,
  BotIcon,
  Columns2Icon,
  FileIcon,
  GlobeIcon,
  LinkIcon,
  PlusIcon,
  Rows3Icon,
  TerminalIcon,
  WebSearchIcon,
} from "~/lib/icons";
import { DISCLOSURE_TRANSITION_MS, disclosureFloatingPanelClassName } from "~/lib/disclosureMotion";
import { cn } from "~/lib/utils";

import { Menu, MenuItem, MenuTrigger } from "../ui/menu";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "../ui/sheet";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
import {
  THREAD_SUMMARY_OVERLAY_RADIUS_PX,
  THREAD_SUMMARY_PANEL_WIDTH_PX,
  THREAD_SUMMARY_SECTION_DEFAULT_OPEN,
  THREAD_SUMMARY_TOOLTIP_DELAY_MS,
} from "./threadSummaryPanel.logic";
import {
  selectThreadSummarySubagentPreview,
  type ThreadSummaryArtifact,
  type ThreadSummaryProcess,
  type ThreadSummarySource,
  type ThreadSummarySubagent,
} from "./threadSummaryPanelModel";

const SUMMARY_INITIAL_VISIBLE_ITEMS = 6;
const SUMMARY_SOURCE_PREVIEW_ITEMS = 3;

export type ThreadSummaryOutputKind = "document" | "presentation" | "spreadsheet" | "site";
export type ThreadSummarySectionKey =
  | "artifacts"
  | "background-subagents"
  | "background-processes"
  | "tool-sources";
export type ThreadSummaryExpandedSections = Partial<Record<ThreadSummarySectionKey, boolean>>;

const THREAD_SUMMARY_OUTPUT_OPTIONS: ReadonlyArray<{
  kind: ThreadSummaryOutputKind;
  label: string;
}> = [
  { kind: "document", label: "创建文档" },
  { kind: "presentation", label: "创建演示文稿" },
  { kind: "spreadsheet", label: "创建电子表格" },
  { kind: "site", label: "创建网站" },
];

function ThreadSummarySection({
  sectionKey,
  title,
  count = 0,
  action,
  defaultOpen = THREAD_SUMMARY_SECTION_DEFAULT_OPEN,
  open: controlledOpen,
  onOpenChange,
  children,
}: {
  sectionKey: ThreadSummarySectionKey;
  title: string;
  count?: number;
  action?: ReactNode;
  defaultOpen?: boolean;
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  children: ReactNode;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const open = controlledOpen ?? uncontrolledOpen;
  const contentId = useId();
  const setOpen = (nextOpen: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };
  return (
    <section
      data-testid={`thread-summary-section-${sectionKey}`}
      data-section-key={sectionKey}
      data-default-open={defaultOpen ? "true" : "false"}
      className={cn(
        "relative z-0 flex flex-col pb-3 after:absolute after:inset-x-3.5 after:bottom-0 after:h-[0.5px] after:bg-[var(--color-border-light)] after:content-[''] last:after:hidden",
        !open && "last:pb-0.5",
      )}
    >
      <header className="sticky top-0 z-10 flex h-7 w-full min-w-0 items-center justify-start gap-2 bg-[var(--color-background-elevated-primary-opaque)] ps-3.5 pe-2.5 pb-0.5 text-ui-lg text-[var(--color-text-foreground-tertiary)]">
        <button
          type="button"
          className="group/section-toggle inline-flex min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-md py-0.5 pr-1 text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-border-accent)]"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen(!open)}
        >
          <span className="truncate">{title}</span>
          {!open && count > 0 ? (
            <span className="text-[var(--color-text-foreground-tertiary)] opacity-50">{count}</span>
          ) : null}
          <DisclosureChevron
            open={open}
            className={cn(
              "size-2.5 group-hover/section-toggle:opacity-100 group-focus-visible/section-toggle:opacity-100",
              open ? "opacity-0" : "opacity-100",
            )}
          />
        </button>
        {action ? <div className="flex min-w-0 flex-1">{action}</div> : null}
      </header>
      <div id={contentId} data-state={open ? "open" : "closed"}>
        <DisclosureRegion
          open={open}
          className="relative z-0"
          contentClassName="mt-0.5 !translate-y-0"
        >
          <div className="flex flex-col gap-0.5 px-3.5">{children}</div>
        </DisclosureRegion>
      </div>
    </section>
  );
}

function SummaryRow({
  icon,
  label,
  detail,
  active = false,
  onClick,
  ariaLabel,
}: {
  icon: ReactNode;
  label: string;
  detail?: string;
  active?: boolean;
  onClick?: (() => void) | undefined;
  ariaLabel?: string | undefined;
}) {
  const content = (
    <>
      <span className="relative flex size-4 shrink-0 items-center justify-center text-[var(--color-text-foreground-secondary)]">
        {icon}
        {active ? (
          <span className="absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full bg-emerald-500 ring-1 ring-[var(--color-background-elevated-primary-opaque)] motion-safe:animate-pulse" />
        ) : null}
      </span>
      <span className="min-w-0 flex-1 truncate text-[var(--color-text-foreground)]">{label}</span>
      {detail ? (
        <span className="shrink-0 truncate text-ui-sm text-[var(--color-text-foreground-tertiary)]">
          {detail}
        </span>
      ) : null}
      {onClick ? (
        <ArrowUpRightIcon className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-50 group-focus-visible:opacity-50" />
      ) : null}
    </>
  );
  const className =
    "group relative isolate flex min-h-7 w-full min-w-0 items-center gap-2 rounded-sm border-0 bg-transparent px-0 py-1 text-left text-ui-lg text-[var(--color-text-foreground)] outline-none before:absolute before:inset-y-0 before:-inset-x-2 before:-z-10 before:rounded-sm before:content-[''] hover:before:bg-[var(--color-background-elevated-secondary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-border-accent)]";

  return onClick ? (
    <button type="button" className={className} onClick={onClick} aria-label={ariaLabel}>
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  );
}

function CreateOutputMenu({
  variant,
  onCreateOutput,
}: {
  variant: "icon" | "row";
  onCreateOutput: (kind: ThreadSummaryOutputKind) => void;
}) {
  const label = "创建文件或站点";
  const trigger =
    variant === "icon" ? (
      <button
        type="button"
        aria-label={label}
        title={label}
        className="flex size-6 items-center justify-center rounded-md text-[var(--color-text-foreground-secondary)] outline-none transition-colors hover:bg-[var(--color-background-elevated-secondary)] hover:text-[var(--color-text-foreground)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-border-accent)]"
      >
        <PlusIcon className="size-4" />
      </button>
    ) : (
      <button
        type="button"
        aria-label={label}
        className="group relative isolate flex min-h-7 w-full min-w-0 cursor-pointer items-center rounded-sm border-0 bg-transparent px-0 py-1 text-left text-ui-lg text-[var(--color-text-foreground)] outline-none before:absolute before:inset-y-0 before:-inset-x-2 before:-z-10 before:rounded-sm before:content-[''] hover:before:bg-[var(--color-background-elevated-secondary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-border-accent)]"
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </button>
    );

  return (
    <Menu>
      {variant === "icon" ? (
        <Tooltip>
          <TooltipTrigger
            delay={THREAD_SUMMARY_TOOLTIP_DELAY_MS}
            render={<MenuTrigger render={trigger} />}
          />
          <TooltipPopup side="bottom">{label}</TooltipPopup>
        </Tooltip>
      ) : (
        <MenuTrigger render={trigger} />
      )}
      <ComposerPickerMenuPopup align="end" side="bottom" sideOffset={4} className="min-w-44">
        {THREAD_SUMMARY_OUTPUT_OPTIONS.map((option) => (
          <MenuItem key={option.kind} onClick={() => onCreateOutput(option.kind)}>
            {option.kind === "document" ? <FileIcon className="size-4" /> : null}
            {option.kind === "presentation" ? <Rows3Icon className="size-4" /> : null}
            {option.kind === "spreadsheet" ? <Columns2Icon className="size-4" /> : null}
            {option.kind === "site" ? <GlobeIcon className="size-4" /> : null}
            {option.label}
          </MenuItem>
        ))}
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

function AddSourceMenu({
  variant,
  onAddSources,
  onConnectApps,
}: {
  variant: "icon" | "row";
  onAddSources: ((files: File[]) => void) | undefined;
  onConnectApps: (() => void) | undefined;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const label = "附加文件或连接应用";
  const trigger =
    variant === "icon" ? (
      <button
        type="button"
        aria-label={label}
        title={label}
        className="flex size-6 items-center justify-center rounded-md text-[var(--color-text-foreground-secondary)] outline-none transition-colors hover:bg-[var(--color-background-elevated-secondary)] hover:text-[var(--color-text-foreground)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-border-accent)]"
      >
        <PlusIcon className="size-4" />
      </button>
    ) : (
      <button
        type="button"
        aria-label={label}
        className="group relative isolate flex min-h-7 w-full min-w-0 cursor-pointer items-center rounded-sm border-0 bg-transparent px-0 py-1 text-left text-ui-lg text-[var(--color-text-foreground)] outline-none before:absolute before:inset-y-0 before:-inset-x-2 before:-z-10 before:rounded-sm before:content-[''] hover:before:bg-[var(--color-background-elevated-secondary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-border-accent)]"
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </button>
    );

  return (
    <>
      <input
        ref={inputRef}
        className="sr-only"
        type="file"
        multiple
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (files.length > 0) onAddSources?.(files);
        }}
      />
      <Menu>
        {variant === "icon" ? (
          <Tooltip>
            <TooltipTrigger
              delay={THREAD_SUMMARY_TOOLTIP_DELAY_MS}
              render={<MenuTrigger render={trigger} />}
            />
            <TooltipPopup side="bottom">{label}</TooltipPopup>
          </Tooltip>
        ) : (
          <MenuTrigger render={trigger} />
        )}
        <ComposerPickerMenuPopup align="end" side="bottom" sideOffset={4} className="min-w-48">
          {onConnectApps ? (
            <MenuItem onClick={onConnectApps}>
              <AppsIcon className="size-4" />
              连接应用
            </MenuItem>
          ) : null}
          {onAddSources ? (
            <MenuItem onClick={() => inputRef.current?.click()}>
              <FileIcon className="size-4" />
              附加文件或文件夹
            </MenuItem>
          ) : null}
        </ComposerPickerMenuPopup>
      </Menu>
    </>
  );
}

function ThreadSummarySourceIcon({ source }: { source: ThreadSummarySource }) {
  if (source.kind === "image" && source.previewUrl) {
    return (
      <img
        src={source.previewUrl}
        alt=""
        className="size-4 rounded-[3px] border border-[var(--color-border-light)] object-cover"
      />
    );
  }
  if (source.kind === "external") return <GlobeIcon className="size-4" />;
  if (source.kind === "tool") return <AppsIcon className="size-4" />;
  if (source.kind === "web") return <WebSearchIcon className="size-4" />;
  return <FileIcon className="size-4" />;
}

function threadSummarySourceDetail(source: ThreadSummarySource): string {
  if (source.kind === "file" || source.kind === "image") return "已附加";
  if (source.kind === "external") return "对话中提供";
  if (source.kind === "tool") return "任务中使用";
  return "任务中搜索";
}

function SubagentOverviewRow({
  subagents,
  onOpen,
}: {
  subagents: ReadonlyArray<ThreadSummarySubagent>;
  onOpen?: (() => void) | undefined;
}) {
  const { preview, workingCount, doneCount } = selectThreadSummarySubagentPreview(subagents);
  const label = workingCount > 0 ? `${workingCount} 个处理中` : `${doneCount} 个已完成`;
  const detail = workingCount > 0 && doneCount > 0 ? `${doneCount} 个已完成` : undefined;

  return (
    <button
      type="button"
      aria-label="打开子智能体"
      disabled={!onOpen}
      onClick={onOpen}
      data-preview-count={preview.length}
      className="group relative isolate flex min-h-7 w-full min-w-0 items-center gap-2 rounded-sm border-0 bg-transparent px-0 py-1 text-left text-ui-lg text-[var(--color-text-foreground)] outline-none before:absolute before:inset-y-0 before:-inset-x-2 before:-z-10 before:rounded-sm before:content-[''] enabled:hover:before:bg-[var(--color-background-elevated-secondary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-border-accent)]"
    >
      <span className="flex shrink-0 items-center gap-1">
        {preview.map((subagent) => (
          <span
            key={subagent.id}
            aria-hidden
            title={subagent.label}
            className="flex size-4 items-center justify-center rounded-full bg-[var(--color-background-elevated-secondary)] text-[var(--color-text-foreground-secondary)]"
          >
            <BotIcon className="size-3" />
          </span>
        ))}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail ? (
        <span className="shrink-0 text-ui-sm text-[var(--color-text-foreground-tertiary)]">
          {detail}
        </span>
      ) : null}
    </button>
  );
}

export interface ThreadSummaryPanelContentProps {
  artifacts: ReadonlyArray<ThreadSummaryArtifact>;
  sources: ReadonlyArray<ThreadSummarySource>;
  subagents: ReadonlyArray<ThreadSummarySubagent>;
  processes: ReadonlyArray<ThreadSummaryProcess>;
  onCreateOutput?: (kind: ThreadSummaryOutputKind) => void;
  onAddSources?: (files: File[]) => void;
  onConnectApps?: () => void;
  onOpenArtifact?: (artifact: ThreadSummaryArtifact) => void;
  onOpenSource?: (source: ThreadSummarySource) => void;
  onOpenSubagent?: (subagent: ThreadSummarySubagent) => void;
  onOpenProcess?: (process: ThreadSummaryProcess) => void;
  expandedSections?: ThreadSummaryExpandedSections;
  onSectionExpandedChange?: (section: ThreadSummarySectionKey, open: boolean) => void;
}

export function ThreadSummaryPanelContent({
  artifacts,
  sources,
  subagents,
  processes,
  onCreateOutput,
  onAddSources,
  onConnectApps,
  onOpenArtifact,
  onOpenSource,
  onOpenSubagent,
  onOpenProcess,
  expandedSections,
  onSectionExpandedChange,
}: ThreadSummaryPanelContentProps) {
  const [visibleArtifactCount, setVisibleArtifactCount] = useState(SUMMARY_INITIAL_VISIBLE_ITEMS);
  const [sourcesSheetOpen, setSourcesSheetOpen] = useState(false);
  const visibleArtifacts = artifacts.slice(0, visibleArtifactCount);
  const visibleSources = sources.slice(0, SUMMARY_SOURCE_PREVIEW_ITEMS);
  const hiddenArtifactCount = Math.max(0, artifacts.length - visibleArtifacts.length);
  const subagentPreview = selectThreadSummarySubagentPreview(subagents);
  const firstSubagentPreview = subagentPreview.preview[0] ?? null;

  return (
    <div
      data-testid="thread-summary-panel"
      data-pip-obstacle="thread-summary-panel"
      data-panel-width={THREAD_SUMMARY_PANEL_WIDTH_PX}
      data-overlay-radius={THREAD_SUMMARY_OVERLAY_RADIUS_PX}
      className="relative flex max-h-[min(var(--available-height,calc(100vh-16px)),calc(100vh-16px))] min-h-0 w-[300px] flex-col overflow-hidden rounded-popover bg-[var(--color-background-elevated-primary-opaque)] pt-2.5 shadow-[0_0_0_0.5px_color-mix(in_srgb,var(--color-border-light)_70%,transparent),0_3px_7.5px_#00000008,0_0_16px_#00000005]"
      style={{ width: THREAD_SUMMARY_PANEL_WIDTH_PX }}
      aria-label="任务摘要"
      role="region"
    >
      <div className="flex h-fit max-h-full min-h-0 flex-col gap-3 overflow-y-auto pb-1.5">
        <ThreadSummarySection
          sectionKey="artifacts"
          title="输出"
          count={artifacts.length}
          open={expandedSections?.artifacts}
          onOpenChange={(open) => onSectionExpandedChange?.("artifacts", open)}
          action={
            onCreateOutput ? (
              <span className="ms-auto flex items-center gap-0.5">
                <CreateOutputMenu variant="icon" onCreateOutput={onCreateOutput} />
              </span>
            ) : null
          }
        >
          {artifacts.length > 0 ? (
            visibleArtifacts.map((artifact) => (
              <SummaryRow
                key={artifact.target}
                icon={
                  artifact.kind === "external" ? (
                    <GlobeIcon className="size-4" />
                  ) : (
                    <FileIcon className="size-4" />
                  )
                }
                label={artifact.label}
                ariaLabel={`打开 ${artifact.label}`}
                onClick={onOpenArtifact ? () => onOpenArtifact(artifact) : undefined}
              />
            ))
          ) : onCreateOutput ? (
            <CreateOutputMenu variant="row" onCreateOutput={onCreateOutput} />
          ) : (
            <p className="px-1.5 py-1 text-ui-lg text-[var(--color-text-foreground-tertiary)]">
              本次任务生成的文件会显示在这里
            </p>
          )}
          {artifacts.length > SUMMARY_INITIAL_VISIBLE_ITEMS ? (
            <button
              type="button"
              className="w-fit rounded-sm py-1 text-left text-ui-lg text-[var(--color-text-foreground-tertiary)] outline-none hover:text-[var(--color-text-foreground-secondary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-border-accent)]"
              onClick={() =>
                setVisibleArtifactCount((current) =>
                  current >= artifacts.length ? SUMMARY_INITIAL_VISIBLE_ITEMS : artifacts.length,
                )
              }
            >
              {hiddenArtifactCount > 0 ? `显示另外 ${hiddenArtifactCount} 项` : "收起"}
            </button>
          ) : null}
        </ThreadSummarySection>

        {subagents.length > 0 ? (
          <ThreadSummarySection
            sectionKey="background-subagents"
            title="子智能体"
            count={subagents.length}
            open={expandedSections?.["background-subagents"]}
            onOpenChange={(open) => onSectionExpandedChange?.("background-subagents", open)}
          >
            {subagents.length > subagentPreview.preview.length ? (
              <SubagentOverviewRow
                subagents={subagents}
                onOpen={
                  onOpenSubagent && firstSubagentPreview
                    ? () => onOpenSubagent(firstSubagentPreview)
                    : undefined
                }
              />
            ) : (
              subagents.map((subagent) => (
                <SummaryRow
                  key={subagent.id}
                  icon={<BotIcon className="size-4" />}
                  label={subagent.label}
                  detail={subagent.statusLabel}
                  active={subagent.active}
                  ariaLabel={`打开子智能体 ${subagent.label}`}
                  onClick={onOpenSubagent ? () => onOpenSubagent(subagent) : undefined}
                />
              ))
            )}
          </ThreadSummarySection>
        ) : null}

        {processes.length > 0 ? (
          <ThreadSummarySection
            sectionKey="background-processes"
            title="后台进程"
            count={processes.length}
            open={expandedSections?.["background-processes"]}
            onOpenChange={(open) => onSectionExpandedChange?.("background-processes", open)}
          >
            {processes.map((process) => (
              <SummaryRow
                key={process.id}
                icon={<TerminalIcon className="size-4" />}
                label={process.label}
                detail={process.active ? "运行中" : "已完成"}
                active={process.active}
                ariaLabel={`打开后台进程 ${process.label}`}
                onClick={onOpenProcess ? () => onOpenProcess(process) : undefined}
              />
            ))}
          </ThreadSummarySection>
        ) : null}

        {sources.length > 0 || onAddSources || onConnectApps ? (
          <ThreadSummarySection
            sectionKey="tool-sources"
            title="来源"
            count={sources.length}
            open={expandedSections?.["tool-sources"]}
            onOpenChange={(open) => onSectionExpandedChange?.("tool-sources", open)}
            action={
              onAddSources || onConnectApps ? (
                <span className="ms-auto flex items-center gap-0.5">
                  <AddSourceMenu
                    variant="icon"
                    onAddSources={onAddSources}
                    onConnectApps={onConnectApps}
                  />
                </span>
              ) : null
            }
          >
            {sources.length === 0 ? (
              <AddSourceMenu
                variant="row"
                onAddSources={onAddSources}
                onConnectApps={onConnectApps}
              />
            ) : (
              <>
                {visibleSources.map((source) => {
                  const openable = Boolean(source.target || source.previewUrl);
                  return (
                    <SummaryRow
                      key={source.id}
                      icon={<ThreadSummarySourceIcon source={source} />}
                      label={source.label}
                      ariaLabel={`打开来源 ${source.label}`}
                      onClick={onOpenSource && openable ? () => onOpenSource(source) : undefined}
                    />
                  );
                })}
                <button
                  type="button"
                  className="group relative isolate flex min-h-7 w-full min-w-0 items-center gap-2 rounded-sm border-0 bg-transparent px-0 py-1 text-left text-ui-lg text-[var(--color-text-foreground-secondary)] outline-none before:absolute before:inset-y-0 before:-inset-x-2 before:-z-10 before:rounded-sm before:content-[''] hover:text-[var(--color-text-foreground)] hover:before:bg-[var(--color-background-elevated-secondary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-border-accent)]"
                  onClick={() => setSourcesSheetOpen(true)}
                >
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    <LinkIcon className="size-4" />
                  </span>
                  <span>查看全部</span>
                </button>
              </>
            )}
          </ThreadSummarySection>
        ) : null}
      </div>
      <Sheet open={sourcesSheetOpen} onOpenChange={setSourcesSheetOpen} modal={false}>
        <SheetPopup
          showBackdrop={false}
          viewportClassName="pointer-events-none"
          className="pointer-events-auto max-w-[360px] duration-220 ease-out"
          data-testid="thread-summary-sources-sheet"
        >
          <SheetHeader className="gap-1 px-5 pb-3 pt-5">
            <SheetTitle className="text-base">来源</SheetTitle>
            <SheetDescription>{sources.length} 个对话来源</SheetDescription>
          </SheetHeader>
          <SheetPanel className="flex flex-col gap-0.5 px-5 pb-5">
            {sources.map((source) => {
              const openable = Boolean(source.target || source.previewUrl);
              return (
                <SummaryRow
                  key={source.id}
                  icon={<ThreadSummarySourceIcon source={source} />}
                  label={source.label}
                  detail={threadSummarySourceDetail(source)}
                  ariaLabel={`打开来源 ${source.label}`}
                  onClick={
                    onOpenSource && openable
                      ? () => {
                          setSourcesSheetOpen(false);
                          onOpenSource(source);
                        }
                      : undefined
                  }
                />
              );
            })}
          </SheetPanel>
        </SheetPopup>
      </Sheet>
    </div>
  );
}

export function ThreadSummaryInlinePanel({
  visible,
  children,
}: {
  visible: boolean;
  children: ReactNode;
}) {
  return (
    <div
      aria-hidden={!visible}
      inert={!visible ? true : undefined}
      data-testid="thread-summary-inline-panel"
      data-state={visible ? "open" : "closed"}
      data-transition-type="disclosure"
      data-transition-duration-ms={DISCLOSURE_TRANSITION_MS}
      className="pointer-events-none absolute inset-y-0 right-0 z-20 flex max-h-full min-h-0 w-[316px] flex-col pe-4 pt-3"
    >
      <div
        className={disclosureFloatingPanelClassName(
          visible,
          cn("min-h-0", visible && "pointer-events-auto"),
        )}
      >
        {children}
      </div>
    </div>
  );
}
