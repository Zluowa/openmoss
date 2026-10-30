// FILE: PluginLibraryPrimitives.tsx
// Purpose: Reusable Codex Plugins/Skills page chrome — the page header with its
//          search/refresh/manage/Add toolbar, pill tabs, section headers, the
//          two-column directory grid and rows, and the expand/collapse row.
// Layer: Web UI primitives
// Exports: PluginLibraryHeader, PluginLibraryHeaderActions, PluginLibraryPageHeader,
//          PluginLibraryPillTabs, PluginLibrarySectionHeader, PluginLibrarySearchInput,
//          geometry primitives, PluginLibraryTwoColumnGrid, PluginLibraryRow,
//          PluginLibraryExpandRow

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileAddIcon,
  ListChecksIcon,
  McpIcon,
  PlusIcon,
  PluginIcon,
  RefreshCwIcon,
  SearchIcon,
  SettingsIcon,
} from "~/lib/icons";
import { useTranslation } from "~/localization";
import { cn } from "~/lib/utils";
import { PAGE_TITLE_CLASS_NAME } from "~/surfaceStyles";
import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuItem, DropdownMenuTrigger } from "./ui/menu";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "./ui/input-group";

export type PluginLibraryBrowseTab = "plugins" | "skills";
export type PluginLibraryHeaderMode = "browse" | "manage";

export interface PluginRequestActionGate {
  readonly authMethod: string | null;
  readonly featureFlagEnabled: boolean;
}

const BROWSE_TABS: readonly PluginLibraryBrowseTab[] = ["plugins", "skills"];

export function canShowPluginRequestAction(input: PluginRequestActionGate): boolean {
  return input.authMethod === "chatgpt" && input.featureFlagEnabled;
}

export interface PluginLibraryHeaderLabels {
  readonly browseAria: string;
  readonly plugins: string;
  readonly skills: string;
  readonly manage: string;
  readonly refresh: string;
  readonly create: string;
  readonly createPlugin: string;
  readonly importPluginsAndSkills?: string;
  readonly uploadPluginArchive?: string;
  readonly addCustomMcpServer?: string;
  readonly addMcpServer?: string;
  readonly createSkill: string;
  readonly recordSkill: string;
  readonly addMarketplace: string;
  readonly requestPlugin: string;
}

const DEFAULT_HEADER_LABELS: PluginLibraryHeaderLabels = {
  browseAria: "Browse plugins or skills",
  plugins: "Plugins",
  skills: "Skills",
  manage: "Manage",
  refresh: "Refresh",
  create: "Create",
  createPlugin: "Create plugin",
  importPluginsAndSkills: "Import plugins and skills",
  uploadPluginArchive: "Upload plugin archive",
  addCustomMcpServer: "Add custom MCP server",
  addMcpServer: "Add MCP server",
  createSkill: "Create skill",
  recordSkill: "Record a skill",
  addMarketplace: "Add marketplace",
  requestPlugin: "Request a plugin",
};

interface HeaderAction {
  readonly key: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly onSelect?: (() => void) | undefined;
}

function BrowseTabButton({
  tab,
  active,
  label,
  buttonRef,
  onKeyDown,
  onClick,
}: {
  readonly tab: PluginLibraryBrowseTab;
  readonly active: boolean;
  readonly label: string;
  readonly buttonRef: (button: HTMLButtonElement | null) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  readonly onClick: () => void;
}) {
  return (
    <button
      id={`plugins-tab-${tab}`}
      type="button"
      role="tab"
      aria-selected={active}
      aria-controls="plugins-page-results"
      tabIndex={active ? 0 : -1}
      ref={buttonRef}
      className={cn(
        "inline-flex h-7 items-center rounded-md px-2.5 text-ui-sm font-medium transition-colors plugin-library-motion",
        active
          ? "bg-[var(--color-background-button-secondary)] text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      {label}
    </button>
  );
}

const ADD_BUTTON_CLASS_NAME = "h-8 gap-1 rounded-full px-3 text-ui-lg font-medium sm:h-8";

/**
 * Codex's "Add" control: a solid pill. With one action it runs that action
 * directly (Skills: Create skill); with more it opens the menu (Add ⌄).
 */
function HeaderCreateMenu({
  actions,
  label,
  triggerRef,
}: {
  readonly actions: readonly HeaderAction[];
  readonly label: string;
  readonly triggerRef?: RefObject<HTMLButtonElement | null> | undefined;
}) {
  if (actions.length === 0) return null;
  const [onlyAction] = actions;
  if (onlyAction && actions.length === 1) {
    return (
      <Button
        ref={triggerRef}
        variant="default"
        size="sm"
        title={onlyAction.label}
        disabled={!onlyAction.onSelect}
        onClick={onlyAction.onSelect}
        className={ADD_BUTTON_CLASS_NAME}
        data-testid="plugin-library-add-menu"
      >
        {label}
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            ref={triggerRef}
            variant="default"
            size="sm"
            aria-label={label}
            className={ADD_BUTTON_CLASS_NAME}
            data-testid="plugin-library-add-menu"
          >
            <span>{label}</span>
            <ChevronDownIcon aria-hidden="true" className="size-3" />
          </Button>
        }
      />
      <ComposerPickerMenuPopup align="end" className="w-60 min-w-60">
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.key}
            disabled={!action.onSelect}
            onClick={action.onSelect}
            className="gap-2.5 text-ui-lg"
          >
            {action.icon}
            {action.label}
          </DropdownMenuItem>
        ))}
      </ComposerPickerMenuPopup>
    </DropdownMenu>
  );
}

interface PluginLibraryCreateCallbacks {
  readonly onCreatePlugin?: (() => void) | undefined;
  /** Legacy entry kept for hosts that still offer one combined import. */
  readonly onImportPluginsAndSkills?: (() => void) | undefined;
  readonly onUploadPluginArchive?: (() => void) | undefined;
  readonly onAddCustomMcpServer?: (() => void) | undefined;
  readonly onCreateSkill?: (() => void) | undefined;
  readonly onRecordSkill?: (() => void) | undefined;
  readonly onAddMarketplace?: (() => void) | undefined;
  readonly onRequestPlugin?: (() => void) | undefined;
  readonly requestPluginGate?: PluginRequestActionGate | undefined;
}

export interface PluginLibraryHeaderProps extends PluginLibraryCreateCallbacks {
  readonly mode: PluginLibraryHeaderMode;
  readonly selectedTab: PluginLibraryBrowseTab;
  readonly labels?: PluginLibraryHeaderLabels | undefined;
  readonly refreshing?: boolean | undefined;
  readonly onTabChange: (tab: PluginLibraryBrowseTab) => void;
  readonly onManage?: (() => void) | undefined;
  readonly onExitManage?: (() => void) | undefined;
  readonly onRefresh: () => void;
  readonly createTriggerRef?: RefObject<HTMLButtonElement | null> | undefined;
  readonly leading?: ReactNode;
  /** Hide the browse tabs when a destination shell already owns them. */
  readonly hideBrowseTabs?: boolean;
  /** Keep the global top chrome to navigation only and render actions in the page toolbar. */
  readonly hideActions?: boolean;
}

export interface PluginLibraryHeaderActionsProps extends PluginLibraryCreateCallbacks {
  readonly mode: PluginLibraryHeaderMode;
  readonly selectedTab: PluginLibraryBrowseTab;
  readonly labels?: PluginLibraryHeaderLabels | undefined;
  readonly refreshing?: boolean | undefined;
  readonly onManage?: (() => void) | undefined;
  readonly onRefresh: () => void;
  readonly createTriggerRef?: RefObject<HTMLButtonElement | null> | undefined;
  /** Codex keeps the page search pill in the same toolbar, before the icon actions. */
  readonly search?: ReactNode;
}

const MENU_ICON_CLASS_NAME = "size-4 text-muted-foreground";

/**
 * Codex's Add menu. Plugins: Create plugin, Add a marketplace, then the
 * archive upload and custom MCP server this host supports. Skills: Create
 * skill (with Record a skill where offered). Settings › Plugins: Create
 * plugin, Add a marketplace, Add MCP server.
 */
function usePluginLibraryHeaderActions({
  mode,
  selectedTab,
  labels,
  onCreatePlugin,
  onImportPluginsAndSkills,
  onUploadPluginArchive,
  onAddCustomMcpServer,
  onCreateSkill,
  onRecordSkill,
  onAddMarketplace,
  onRequestPlugin,
  requestPluginGate,
}: PluginLibraryCreateCallbacks & {
  readonly mode: PluginLibraryHeaderMode;
  readonly selectedTab: PluginLibraryBrowseTab;
  readonly labels: PluginLibraryHeaderLabels;
}) {
  const { t } = useTranslation();
  return useMemo<HeaderAction[]>(() => {
    const next: HeaderAction[] = [];
    if (mode === "browse" && selectedTab === "skills") {
      next.push({
        key: "create-skill",
        label: labels.createSkill,
        icon: <ListChecksIcon className={MENU_ICON_CLASS_NAME} />,
        onSelect: onCreateSkill,
      });
      if (onRecordSkill) {
        next.push({
          key: "record-skill",
          label: labels.recordSkill,
          icon: <ListChecksIcon className={MENU_ICON_CLASS_NAME} />,
          onSelect: onRecordSkill,
        });
      }
      return next;
    }
    next.push({
      key: "create-plugin",
      label: labels.createPlugin,
      icon: <PluginIcon className={MENU_ICON_CLASS_NAME} />,
      onSelect: onCreatePlugin,
    });
    if (onAddMarketplace) {
      next.push({
        key: "add-marketplace",
        label: labels.addMarketplace,
        icon: <PlusIcon className={MENU_ICON_CLASS_NAME} />,
        onSelect: onAddMarketplace,
      });
    }
    const uploadArchive =
      mode === "browse" ? (onUploadPluginArchive ?? onImportPluginsAndSkills) : undefined;
    if (uploadArchive) {
      next.push({
        key: "upload-plugin-archive",
        label: onUploadPluginArchive
          ? (labels.uploadPluginArchive ?? t("plugins.action.uploadPluginArchive"))
          : (labels.importPluginsAndSkills ?? t("plugins.action.importPluginsAndSkills")),
        icon: <FileAddIcon className={MENU_ICON_CLASS_NAME} />,
        onSelect: uploadArchive,
      });
    }
    if (onAddCustomMcpServer) {
      next.push(
        mode === "manage"
          ? {
              key: "add-mcp-server",
              label: labels.addMcpServer ?? t("plugins.action.addMcpServer"),
              icon: <McpIcon className={MENU_ICON_CLASS_NAME} />,
              onSelect: onAddCustomMcpServer,
            }
          : {
              key: "add-custom-mcp-server",
              label: labels.addCustomMcpServer ?? t("plugins.action.addCustomMcpServer"),
              icon: <McpIcon className={MENU_ICON_CLASS_NAME} />,
              onSelect: onAddCustomMcpServer,
            },
      );
    }
    if (
      mode === "browse" &&
      selectedTab === "plugins" &&
      onRequestPlugin &&
      requestPluginGate &&
      canShowPluginRequestAction(requestPluginGate)
    ) {
      next.push({
        key: "request-plugin",
        label: labels.requestPlugin,
        icon: <PluginIcon className={MENU_ICON_CLASS_NAME} />,
        onSelect: onRequestPlugin,
      });
    }
    return next;
  }, [
    labels,
    mode,
    onAddCustomMcpServer,
    onAddMarketplace,
    onCreatePlugin,
    onImportPluginsAndSkills,
    onCreateSkill,
    onRecordSkill,
    onRequestPlugin,
    onUploadPluginArchive,
    requestPluginGate,
    selectedTab,
    t,
  ]);
}

/** The Add menu alone, for pages that lay out their own toolbar (Settings › Plugins). */
export function PluginLibraryAddMenu({
  mode,
  selectedTab,
  labels = DEFAULT_HEADER_LABELS,
  triggerRef,
  ...createCallbacks
}: PluginLibraryCreateCallbacks & {
  readonly mode: PluginLibraryHeaderMode;
  readonly selectedTab: PluginLibraryBrowseTab;
  readonly labels?: PluginLibraryHeaderLabels | undefined;
  readonly triggerRef?: RefObject<HTMLButtonElement | null> | undefined;
}) {
  const actions = usePluginLibraryHeaderActions({
    mode,
    selectedTab,
    labels,
    ...createCallbacks,
  });
  return <HeaderCreateMenu actions={actions} label={labels.create} triggerRef={triggerRef} />;
}

export function PluginLibraryHeaderActions({
  mode,
  selectedTab,
  labels = DEFAULT_HEADER_LABELS,
  refreshing = false,
  onManage,
  onRefresh,
  createTriggerRef,
  search,
  ...createCallbacks
}: PluginLibraryHeaderActionsProps) {
  const actions = usePluginLibraryHeaderActions({
    mode,
    selectedTab,
    labels,
    ...createCallbacks,
  });
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-2">
      {search}
      <div className="flex items-center">
        <Button
          variant="ghost"
          size="icon"
          aria-label={labels.refresh}
          title={labels.refresh}
          aria-busy={refreshing || undefined}
          disabled={refreshing}
          onClick={onRefresh}
          className="sm:size-8"
        >
          <RefreshCwIcon
            className={cn("size-4", refreshing && "animate-spin motion-reduce:animate-none")}
          />
        </Button>
        {mode === "browse" && onManage ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label={labels.manage}
            title={labels.manage}
            data-plugin-library-focus-key="header:manage"
            onClick={() => onManage()}
            className="sm:size-8"
          >
            <SettingsIcon className="size-4" />
          </Button>
        ) : null}
      </div>
      {/* Codex hides Add on Skills while Create skill is unavailable. */}
      {mode === "browse" && selectedTab === "skills" && actions.every((a) => !a.onSelect) ? null : (
        <HeaderCreateMenu actions={actions} label={labels.create} triggerRef={createTriggerRef} />
      )}
    </div>
  );
}

export function PluginLibraryHeader({
  mode,
  selectedTab,
  labels = DEFAULT_HEADER_LABELS,
  refreshing = false,
  onTabChange,
  onManage,
  onExitManage,
  onRefresh,
  createTriggerRef,
  leading,
  hideBrowseTabs = false,
  hideActions = false,
  ...createCallbacks
}: PluginLibraryHeaderProps) {
  const browseTabRefs = useRef<Record<PluginLibraryBrowseTab, HTMLButtonElement | null>>({
    plugins: null,
    skills: null,
  });
  const handleBrowseTabKeyDown = (
    tab: PluginLibraryBrowseTab,
    event: KeyboardEvent<HTMLButtonElement>,
  ) => {
    const currentIndex = BROWSE_TABS.indexOf(tab);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % BROWSE_TABS.length;
    if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + BROWSE_TABS.length) % BROWSE_TABS.length;
    }
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = BROWSE_TABS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = BROWSE_TABS[nextIndex];
    if (!nextTab) return;
    browseTabRefs.current[nextTab]?.focus();
    onTabChange(nextTab);
  };
  return (
    <div
      className="plugin-library-header flex w-full shrink-0 items-center gap-3"
      data-testid="plugin-library-header"
    >
      {leading}
      {mode === "browse" ? (
        hideBrowseTabs ? null : (
          <div
            role="tablist"
            aria-label={labels.browseAria}
            aria-orientation="horizontal"
            className="inline-flex h-8 items-center rounded-lg bg-[var(--color-background-elevated-secondary)] p-0.5"
          >
            {BROWSE_TABS.map((tab) => (
              <BrowseTabButton
                key={tab}
                tab={tab}
                label={tab === "plugins" ? labels.plugins : labels.skills}
                active={selectedTab === tab}
                buttonRef={(button) => {
                  browseTabRefs.current[tab] = button;
                }}
                onKeyDown={(event) => handleBrowseTabKeyDown(tab, event)}
                onClick={() => onTabChange(tab)}
              />
            ))}
          </div>
        )
      ) : (
        <nav aria-label={labels.manage} className="flex min-w-0 items-center gap-1 text-ui">
          <button
            type="button"
            className="rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-[var(--sidebar-accent)] hover:text-foreground plugin-library-motion"
            onClick={onExitManage}
          >
            {labels.plugins}
          </button>
          <span aria-hidden="true" className="text-muted-foreground/50">
            /
          </span>
          <span aria-current="page" className="truncate px-1.5 py-1 font-medium text-foreground">
            {labels.manage}
          </span>
        </nav>
      )}
      <div className="flex-1" />
      {hideActions ? null : (
        <PluginLibraryHeaderActions
          mode={mode}
          selectedTab={selectedTab}
          labels={labels}
          refreshing={refreshing}
          onManage={onManage}
          onRefresh={onRefresh}
          createTriggerRef={createTriggerRef}
          {...createCallbacks}
        />
      )}
    </div>
  );
}

/**
 * Codex page header: a 24px title with the search/refresh/manage/Add toolbar on
 * the same row, and a one-line subtitle under it.
 */
export function PluginLibraryPageHeader({
  title,
  subtitle,
  actions,
}: {
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-2" data-testid="plugin-library-page-header">
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <h1 className={PAGE_TITLE_CLASS_NAME}>{title}</h1>
        {actions}
      </div>
      {subtitle ? <p className="text-ui-lg leading-5 text-muted-foreground">{subtitle}</p> : null}
    </header>
  );
}

export interface PluginLibraryPillTab<TId extends string> {
  readonly id: TId;
  readonly label: string;
}

/**
 * Codex's directory/scope tabs (Public · Personal, Personal · System): 36px
 * pills where only the selected one carries a tint. Arrow keys, Home and End
 * move the selection like any tablist.
 */
export function PluginLibraryPillTabs<TId extends string>({
  ariaLabel,
  tabs,
  selected,
  onSelect,
  testId,
}: {
  readonly ariaLabel: string;
  readonly tabs: ReadonlyArray<PluginLibraryPillTab<TId>>;
  readonly selected: TId;
  readonly onSelect: (id: TId) => void;
  readonly testId?: string;
}) {
  const refs = useRef(new Map<TId, HTMLButtonElement>());
  const handleKeyDown = (index: number, event: KeyboardEvent<HTMLButtonElement>) => {
    const last = tabs.length - 1;
    const nextIndex =
      event.key === "ArrowRight"
        ? index === last
          ? 0
          : index + 1
        : event.key === "ArrowLeft"
          ? index === 0
            ? last
            : index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    const next = nextIndex === null ? undefined : tabs[nextIndex];
    if (!next) return;
    event.preventDefault();
    refs.current.get(next.id)?.focus();
    onSelect(next.id);
  };
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="flex min-w-0 items-center gap-1 overflow-x-auto"
      data-testid={testId}
    >
      {tabs.map((tab, index) => {
        const active = tab.id === selected;
        return (
          <button
            key={tab.id}
            ref={(button) => {
              if (button) refs.current.set(tab.id, button);
              else refs.current.delete(tab.id);
            }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(event) => handleKeyDown(index, event)}
            className={cn(
              "inline-flex h-9 shrink-0 items-center rounded-full px-4 text-ui-lg leading-5 outline-none transition-colors plugin-library-motion focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "bg-foreground/[0.06] text-foreground"
                : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Codex section heading. A category heading is a link ("Popular ›") that opens
 * the category page; Installed-style headings sit on a hairline instead.
 */
export function PluginLibrarySectionHeader({
  title,
  count,
  onOpen,
  divided = false,
  trailing,
  testId,
}: {
  readonly title: string;
  readonly count?: number | undefined;
  readonly onOpen?: (() => void) | undefined;
  readonly divided?: boolean;
  readonly trailing?: ReactNode;
  readonly testId?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-7 items-center justify-between gap-3",
        divided && "border-b border-border/60 pb-3",
      )}
    >
      <h2 className="flex min-w-0 items-center gap-1.5 text-[16px] font-medium leading-6 text-foreground">
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            data-testid={testId}
            className="group/section-link flex min-w-0 items-center gap-0.5 rounded-md text-left outline-none transition-colors hover:text-foreground/75 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="truncate">{title}</span>
            <ChevronRightIcon
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground transition-transform plugin-library-motion group-hover/section-link:translate-x-0.5"
            />
          </button>
        ) : (
          <span className="truncate" data-testid={testId}>
            {title}
          </span>
        )}
        {count === undefined ? null : (
          <span className="font-normal text-muted-foreground">{count}</span>
        )}
      </h2>
      {trailing}
    </div>
  );
}

export function PluginLibraryCardIconBox({
  children,
  className,
  style,
}: {
  readonly children: ReactNode;
  readonly className?: string | undefined;
  readonly style?: React.CSSProperties | undefined;
}) {
  return (
    <span
      className={cn(
        "plugin-library-card-icon flex shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-card ring-1 ring-border/70 ring-inset",
        className,
      )}
      data-testid="plugin-library-card-icon"
      style={style}
    >
      {children}
    </span>
  );
}

export function PluginLibraryDetailIconBox({
  children,
  bordered = true,
}: {
  readonly children: ReactNode;
  readonly bordered?: boolean | undefined;
}) {
  return (
    <span
      className={cn(
        "plugin-library-detail-icon flex shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-card",
        bordered && "ring-1 ring-border/70 ring-inset",
      )}
      data-testid="plugin-library-detail-icon"
    >
      {children}
    </span>
  );
}

export function PluginLibraryOneLineDescription({ children }: { readonly children: ReactNode }) {
  return (
    <span className="plugin-library-one-line" data-testid="plugin-library-one-line">
      {children}
    </span>
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

export interface PluginLibrarySearchInputProps {
  readonly value: string;
  readonly placeholder: string;
  readonly resultIds: readonly string[];
  readonly onChange: (value: string) => void;
  readonly onActivateResult: (id: string) => void;
  readonly onActiveResultChange?: ((id: string | null) => void) | undefined;
  readonly className?: string | undefined;
}

export function PluginLibrarySearchInput({
  value,
  placeholder,
  resultIds,
  onChange,
  onActivateResult,
  onActiveResultChange,
  className,
}: PluginLibrarySearchInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [activeResultId, setActiveResultId] = useState<string | null>(null);

  const updateActiveResult = (id: string | null) => {
    setActiveResultId(id);
    onActiveResultChange?.(id);
  };

  useEffect(() => {
    if (activeResultId !== null && !resultIds.includes(activeResultId)) {
      setActiveResultId(null);
      onActiveResultChange?.(null);
    }
  }, [activeResultId, onActiveResultChange, resultIds]);

  useEffect(() => {
    inputRef.current = document.getElementById("plugins-page-search") as HTMLInputElement | null;
    return () => {
      inputRef.current = null;
    };
  }, []);

  useEffect(() => {
    const focusSearch = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "f") return;
      if (isEditableTarget(event.target) && event.target !== inputRef.current) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (resultIds.length === 0) return;
    const currentIndex = activeResultId === null ? -1 : resultIds.indexOf(activeResultId);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const initialIndex = delta > 0 ? 0 : resultIds.length - 1;
      const nextIndex =
        currentIndex < 0
          ? initialIndex
          : (currentIndex + delta + resultIds.length) % resultIds.length;
      updateActiveResult(resultIds[nextIndex] ?? null);
      return;
    }
    if (event.key === "Enter" && activeResultId !== null) {
      event.preventDefault();
      onActivateResult(activeResultId);
    }
  };

  return (
    <InputGroup className={cn("h-8 rounded-full bg-background/70 shadow-xs", className)}>
      <InputGroupAddon>
        <InputGroupText>
          <SearchIcon className="size-4 text-muted-foreground/60" />
        </InputGroupText>
      </InputGroupAddon>
      <InputGroupInput
        id="plugins-page-search"
        role="combobox"
        aria-label={placeholder}
        aria-controls="plugins-page-results"
        aria-expanded={resultIds.length > 0}
        aria-activedescendant={activeResultId ?? undefined}
        value={value}
        placeholder={placeholder}
        className="text-ui-lg"
        onChange={(event) => {
          updateActiveResult(null);
          onChange(event.target.value);
        }}
        onKeyDown={handleKeyDown}
      />
    </InputGroup>
  );
}

export function PluginLibraryTwoColumnGrid({ children }: { readonly children: ReactNode }) {
  return (
    <div className="plugin-library-grid-container">
      <div className="plugin-library-plugin-grid" data-testid="plugin-library-grid">
        {children}
      </div>
    </div>
  );
}

/**
 * Codex directory row: a borderless 68px row whose hover surface bleeds 10px
 * past the column so the icon stays on the page's text edge. A 36px icon tile,
 * name (with an optional origin badge) over a one-line description, and one
 * trailing control — "+" before install, "…" once installed, ✓ for skills.
 */
export function PluginLibraryRow({
  glyph,
  title,
  titleAccessory,
  description,
  action,
  onOpen,
  overflow,
  domId,
  focusKey,
  active = false,
  dimmed = false,
}: {
  glyph: ReactNode;
  title: string;
  titleAccessory?: ReactNode;
  description: string;
  action: ReactNode;
  onOpen: (trigger: HTMLButtonElement) => void;
  overflow?: ReactNode;
  domId?: string;
  focusKey?: string;
  active?: boolean;
  dimmed?: boolean;
}) {
  return (
    <article
      id={domId}
      data-search-result-active={active || undefined}
      className={cn(
        "plugin-library-plugin-row group -mx-2.5 flex items-center gap-3 rounded-xl px-2.5 transition-colors plugin-library-motion hover:bg-foreground/[0.04] focus-within:bg-foreground/[0.04]",
        active && "bg-foreground/[0.06] ring-1 ring-foreground/15",
      )}
    >
      <button
        type="button"
        aria-label={title}
        data-plugin-library-focus-key={focusKey}
        onClick={(event) => onOpen(event.currentTarget)}
        className={cn(
          "flex min-w-0 flex-1 cursor-pointer items-center gap-3 self-stretch rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
          dimmed && "opacity-60",
        )}
      >
        <span className="shrink-0">{glyph}</span>
        <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-ui-lg font-medium leading-5 text-foreground">
              {title}
            </span>
            {titleAccessory}
          </span>
          <PluginLibraryOneLineDescription>
            <span className="text-ui leading-5 text-muted-foreground" data-translation-skip="true">
              {description}
            </span>
          </PluginLibraryOneLineDescription>
        </span>
      </button>
      <div className="flex shrink-0 items-center">
        {action}
        {overflow}
      </div>
    </article>
  );
}

/**
 * Codex's section expander: under a capped list it previews what is hidden
 * ("See Gmail, Figma and 3 more"); expanded, the same row reads "Show less".
 */
export function PluginLibraryExpandRow({
  expanded,
  collapsedLabel,
  expandedLabel,
  icons,
  onToggle,
}: {
  readonly expanded: boolean;
  readonly collapsedLabel: string;
  readonly expandedLabel: string;
  readonly icons?: ReactNode;
  readonly onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      data-testid="plugin-library-expand-row"
      className="mt-1 flex min-h-9 w-full items-center gap-3 rounded-[10px] py-1.5 text-left text-ui-lg leading-relaxed text-muted-foreground outline-none transition-colors plugin-library-motion hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      {!expanded && icons ? <span className="flex shrink-0 -space-x-1.5">{icons}</span> : null}
      <span className="min-w-0 truncate">{expanded ? expandedLabel : collapsedLabel}</span>
    </button>
  );
}
