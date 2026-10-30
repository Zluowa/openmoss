import type {
  ComputerHistoryApp,
  ComputerHistoryClearScope,
  ComputerHistorySettings,
  ComputerHistoryState,
  ComputerHistoryTimelineEntry,
} from "@synara/contracts";
import {
  COMPUTER_HISTORY_MENTION_REFERENCE,
  COMPUTER_HISTORY_MENTION_TOKEN,
} from "@synara/shared/computerHistoryMention";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { useComposerDraftStore } from "~/composerDraftStore";
import {
  ComputerHistoryAskIcon,
  ComputerHistoryBookIcon,
  ComputerHistoryChevronDownIcon,
  ComputerHistoryChevronRightIcon,
  ComputerHistoryClipboardIcon,
  ComputerHistoryFolderIcon,
  ComputerHistoryGlobeIcon,
  ComputerHistoryInfoIcon,
  ComputerHistoryPersonVideoIcon,
  ComputerHistoryPlusIcon,
  ComputerHistoryPreviousIcon,
  ComputerHistoryRemoveIcon,
  ComputerHistorySearchIcon,
  ComputerHistoryTrashIcon,
} from "~/components/settings/ComputerHistoryIcons";
import { SettingsCard } from "~/components/settings/SettingsPanelPrimitives";
import { ComputerHistoryModal } from "~/components/settings/ComputerHistorySettingsDialogs";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Menu, MenuItem, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "~/components/ui/menu";
import { Switch } from "~/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { LoaderIcon } from "~/lib/icons";
import {
  CLEAR_SCOPE_LABELS,
  DEFAULT_SETTINGS,
  dateHeading,
  browserPermissionSubtitle,
  clearScopeQuestionKey,
  extractComputerHistoryErrorCode,
  formatTimelineEntryTime,
  formatTimelineIntervalTooltip,
  fallbackApplicationName,
  isComputerHistoryApplicationIncluded,
  normalizeHostInput,
  segmentExampleText,
  timelineDayGroups,
  timelineHasGap,
  toggleTimelineCluster,
  type PermissionMode,
} from "~/components/settings/ComputerHistorySettingsPanel.model";
import { toastManager } from "~/components/ui/toast";
import { useHandleNewChat } from "~/hooks/useHandleNewChat";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { useTranslation, type TranslationKey } from "~/localization";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";

const COMPUTER_HISTORY_LEARN_MORE_URL = "https://trymoss.com/docs";

const COMPUTER_HISTORY_TOOLTIP_CLASS_NAME =
  "!rounded-lg !border !border-[var(--color-text-foreground)] !bg-[var(--color-background-primary-solid)] !px-2 !py-1.5 !text-ui !leading-[18px] !text-[var(--color-text-primary-solid)] !shadow-none !backdrop-blur-0";
const COMPUTER_HISTORY_TOOLTIP_VIEWPORT_CLASS_NAME = "!px-0 !py-0";
const COMPUTER_HISTORY_TOOLBAR_BUTTON_CLASS_NAME =
  "!h-7 !rounded-lg !px-2 !text-ui-lg !leading-[18px]";
const COMPUTER_HISTORY_DEFAULT_BUTTON_CLASS_NAME =
  "!h-6 !min-h-0 !rounded-lg !px-2 !py-0.5 !text-ui !leading-[18px]";
const COMPUTER_HISTORY_CLEAR_BUTTON_CLASS_NAME =
  "!h-7 !rounded-lg !gap-1.5 !px-3 !text-ui-lg !leading-[18px]";
const COMPUTER_HISTORY_DIALOG_BUTTON_CLASS_NAME =
  "!h-auto !min-h-0 !rounded-lg !px-4 !py-1.5 !text-ui-lg !leading-[18px]";

function ComputerHistorySettingsRow({
  title,
  description,
  control,
}: {
  title: ReactNode;
  description: ReactNode;
  control: ReactNode;
}) {
  return (
    <div
      className="relative flex items-center justify-between gap-6 px-4 py-3"
      data-slot="settings-row"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="min-w-0 text-ui leading-[18px] font-medium text-foreground">{title}</div>
          <div className="min-w-0 text-ui-sm leading-4 text-balance text-[var(--color-text-foreground-secondary)]">
            {description}
          </div>
        </div>
      </div>
      <div className="flex max-w-full shrink-0 items-center gap-3">{control}</div>
    </div>
  );
}

function ComputerHistoryLearnMore({ label, testId }: { label: string; testId: string }) {
  return (
    <a
      href={COMPUTER_HISTORY_LEARN_MORE_URL}
      target="_blank"
      rel="noreferrer"
      className="text-[var(--color-token-text-link-foreground)]"
      data-testid={testId}
      onClick={(event) => {
        event.preventDefault();
        void ensureNativeApi()
          .shell.openExternal(COMPUTER_HISTORY_LEARN_MORE_URL)
          .catch(() => {});
      }}
    >
      {label}
    </a>
  );
}

const OFF_STATE_EXAMPLES = [
  {
    key: "follow-up",
    user: "settings.history.off.example.followUp.user",
    assistant: "settings.history.off.example.followUp.assistant",
  },
  {
    key: "before-lunch",
    user: "settings.history.off.example.beforeLunch.user",
    assistant: "settings.history.off.example.beforeLunch.assistant",
  },
  {
    key: "planning-document",
    user: "settings.history.off.example.planningDocument.user",
    assistant: "settings.history.off.example.planningDocument.assistant",
  },
  {
    key: "remodel",
    user: "settings.history.off.example.remodel.user",
    assistant: "settings.history.off.example.remodel.assistant",
  },
] as const satisfies ReadonlyArray<{
  key: string;
  user: TranslationKey;
  assistant: TranslationKey;
}>;

const ASK_ABOUT_HISTORY_PROMPTS = [
  "Give me a list of tasks I’ve worked on today and their status",
  "Prepare a summary of what I did yesterday for standup",
  "Where can I find the proposal document I was looking for earlier today?",
  "Who contacted me today that I need to follow up with?",
  "Roast my computer behavior",
  "How often do I get distracted, and what usually pulls me off task?",
  "Give me feedback on how I operate day to day",
  "Analyse the writing samples you have from me and describe my writing style with examples and guidelines",
  "Create a reusable skill that writes like me",
  "What keyboard shortcuts do I use most? And which should I be using more?",
  "Where am I being ineffective, and what should I be using AI for instead?",
  "What is my most commonly used phrase?",
  "How do I split my time between focused work, switching tabs, and returning to unfinished tasks?",
  "What was I working on before my last break?",
] as const;

const OFF_STATE_MOTION_STYLE = `
[data-testid="computer-history-off-state"] {
  --transition-duration-basic: .15s;
  --transition-duration-relaxed: .3s;
  --ease-enter-snappy: cubic-bezier(.23,1,.32,1);
}
@keyframes moss-computer-history-user-send {
  from { opacity: 0; transform: translateY(170px) scale(.98); }
  70%, to { opacity: 1; }
  to { transform: translateY(0) scale(1); }
}
@keyframes moss-computer-history-word-appear {
  from { opacity: 0; }
  to { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  [data-computer-history-example-user], [data-computer-history-example-word] {
    animation-duration: 1ms !important;
    animation-delay: 0s !important;
  }
}
`;

function InfoTooltip({ label, description }: { label: string; description: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        delay={0}
        render={
          <button
            type="button"
            aria-label={label}
            className="inline-flex size-4 cursor-interaction items-center justify-center text-tertiary outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <ComputerHistoryInfoIcon className="size-4" aria-hidden="true" />
          </button>
        }
      />
      <TooltipPopup
        side="top"
        sideOffset={2}
        className={COMPUTER_HISTORY_TOOLTIP_CLASS_NAME}
        viewportClassName={COMPUTER_HISTORY_TOOLTIP_VIEWPORT_CLASS_NAME}
      >
        {description}
      </TooltipPopup>
    </Tooltip>
  );
}

const HISTORY_APP_ICON_MAX_DATA_URL_LENGTH = 192_000;
const HISTORY_APP_ICON_DATA_URL_PATTERN = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u;

function validatedAppIconDataURL(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > HISTORY_APP_ICON_MAX_DATA_URL_LENGTH ||
    !HISTORY_APP_ICON_DATA_URL_PATTERN.test(value)
  ) {
    return null;
  }
  return value;
}

function AppIcon({
  name,
  iconDataURL,
  className,
}: {
  name: string;
  iconDataURL?: string | undefined;
  className?: string;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const validatedIcon = validatedAppIconDataURL(iconDataURL);
  useEffect(() => {
    setImageFailed(false);
  }, [validatedIcon]);
  if (validatedIcon && !imageFailed) {
    return (
      <img
        src={validatedIcon}
        alt=""
        aria-hidden="true"
        className={cn("size-6 shrink-0 rounded-lg object-contain", className)}
        onError={() => setImageFailed(true)}
      />
    );
  }
  return (
    <span
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-lg bg-foreground/5 text-ui-2xs font-medium text-muted-foreground",
        className,
      )}
      aria-hidden="true"
    >
      {name.trim().slice(0, 1) || "?"}
    </span>
  );
}

function AnimatedExample({
  user,
  assistant,
  index,
  total,
  onPrevious,
  onNext,
  t,
  format,
  locale,
}: {
  user: string;
  assistant: string;
  index: number;
  total: number;
  onPrevious: () => void;
  onNext: () => void;
  t: (key: TranslationKey) => string;
  format: (key: TranslationKey, values: Record<string, string | number>) => string;
  locale: string;
}) {
  const words = segmentExampleText(assistant, locale);
  const positionLabel = format("settings.history.off.example.position", {
    current: index + 1,
    total,
  });
  return (
    <>
      <style>{OFF_STATE_MOTION_STYLE}</style>
      <div
        className="relative min-h-[340px] overflow-hidden"
        data-testid="computer-history-off-example"
      >
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-[radial-gradient(circle_at_24%_28%,rgba(109,167,255,.95),transparent_34%),radial-gradient(circle_at_72%_68%,rgba(168,94,255,.88),transparent_42%),linear-gradient(135deg,#101b44,#2e1462_58%,#071833)] bg-cover bg-[center_44%]"
        />
        <div className="group/example absolute inset-5 z-10 flex min-h-0 flex-col overflow-y-auto rounded-xl border border-border bg-background/95 p-5 pb-12 text-ui-lg leading-5 text-foreground [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <p
            className="ms-auto max-w-[77%] min-w-0 overflow-hidden break-words rounded-2xl bg-foreground/5 px-3 py-2 opacity-0"
            data-computer-history-example-user
            style={{
              animation:
                "moss-computer-history-user-send calc(var(--transition-duration-relaxed, .3s) + var(--transition-duration-basic, .15s)) var(--ease-enter-snappy, cubic-bezier(.23,1,.32,1)) forwards",
            }}
          >
            {user}
          </p>
          <p className="mt-4 text-[var(--color-text-foreground-secondary)]" aria-live="polite">
            <span className="sr-only">
              {index === 2
                ? `${assistant} ${t("settings.history.off.example.planningDocument.link")}`
                : assistant}
            </span>
            <span aria-hidden="true">
              {words.map(({ text, delayIndex }, wordIndex) => (
                <span
                  key={`${index}-${wordIndex}`}
                  className="opacity-0"
                  data-computer-history-example-word
                  style={
                    {
                      animation:
                        "moss-computer-history-word-appear var(--transition-duration-relaxed, .3s) ease-out forwards",
                      animationDelay: `calc(var(--transition-duration-relaxed, .3s) + var(--transition-duration-basic, .15s) + ${delayIndex} * 75ms)`,
                    } as CSSProperties
                  }
                >
                  {text}
                </span>
              ))}
              {index === 2 ? (
                <span
                  className="inline text-[var(--color-token-text-link-foreground)] opacity-0"
                  data-computer-history-example-word
                  style={{
                    animation:
                      "moss-computer-history-word-appear var(--transition-duration-relaxed, .3s) ease-out forwards",
                    animationDelay: `calc(var(--transition-duration-relaxed, .3s) + var(--transition-duration-basic, .15s) + ${(words.at(-1)?.delayIndex ?? -1) + 1} * 75ms)`,
                  }}
                >
                  {" "}
                  {t("settings.history.off.example.planningDocument.link")}
                </span>
              ) : null}
            </span>
          </p>
          <div className="absolute right-3 bottom-3 flex gap-1 opacity-0 transition-opacity duration-150 group-focus-within/example:opacity-100 group-hover/example:opacity-100 motion-reduce:transition-none">
            <button
              type="button"
              aria-label={t("settings.history.off.example.previous")}
              className="inline-flex size-[26px] items-center justify-center rounded-lg border border-border bg-secondary text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onClick={onPrevious}
            >
              <ComputerHistoryPreviousIcon className="size-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={t("settings.history.off.example.next")}
              className="inline-flex size-[26px] items-center justify-center rounded-lg border border-border bg-secondary text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onClick={onNext}
            >
              <ComputerHistoryPreviousIcon
                className="size-4 -scale-x-100 transform"
                aria-hidden="true"
              />
            </button>
          </div>
        </div>
        <div
          className="absolute bottom-[9px] left-1/2 flex -translate-x-1/2 items-center gap-[5px]"
          role="status"
          aria-label={positionLabel}
        >
          {Array.from({ length: total }, (_, dotIndex) => (
            <span
              key={dotIndex}
              className={cn(
                "size-1 rounded-full bg-foreground",
                dotIndex !== index && "opacity-50",
              )}
              aria-hidden="true"
            />
          ))}
        </div>
      </div>
    </>
  );
}

function OffState({
  disabled,
  disabledReason,
  onTurnOn,
  t,
  format,
  locale,
}: {
  disabled: boolean;
  disabledReason?: string;
  onTurnOn: () => void;
  t: (key: TranslationKey) => string;
  format: (key: TranslationKey, values: Record<string, string | number>) => string;
  locale: string;
}) {
  const [exampleIndex, setExampleIndex] = useState(0);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const example = OFF_STATE_EXAMPLES[exampleIndex] ?? OFF_STATE_EXAMPLES[0]!;
  useEffect(() => {
    if (reducedMotion) return;
    const timer = window.setTimeout(() => {
      setExampleIndex((current) => (current + 1) % OFF_STATE_EXAMPLES.length);
    }, 14_000);
    return () => window.clearTimeout(timer);
  }, [exampleIndex, reducedMotion]);
  return (
    <div className="flex flex-col" data-testid="computer-history-off-state">
      <section className="grid min-h-[340px] grid-cols-2 overflow-hidden rounded-2xl border border-border bg-[var(--color-background-panel)] max-md:grid-cols-1">
        <div className="flex min-w-0 flex-col items-start justify-center px-9 py-[30px] text-start">
          <h2 className="text-base font-medium leading-6">{t("settings.history.off.title")}</h2>
          <div className="mt-[5px] flex max-w-[300px] flex-col gap-3 text-ui leading-[18px] text-muted-foreground">
            <p>{t("settings.history.off.description")}</p>
            <p>{t("settings.history.off.benefits")}</p>
          </div>
          <span
            className={cn(
              "mt-4 inline-flex",
              disabled &&
                "cursor-not-allowed rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
            tabIndex={disabled ? 0 : undefined}
            title={disabled ? disabledReason : undefined}
          >
            <Button
              variant="default"
              size="sm"
              className={COMPUTER_HISTORY_DEFAULT_BUTTON_CLASS_NAME}
              disabled={disabled}
              onClick={onTurnOn}
              data-testid="computer-history-turn-on"
            >
              {t("settings.history.turnOnAction")}
            </Button>
          </span>
        </div>
        <AnimatedExample
          key={example.key}
          user={t(example.user)}
          assistant={t(example.assistant)}
          index={exampleIndex}
          total={OFF_STATE_EXAMPLES.length}
          onPrevious={() =>
            setExampleIndex(
              (current) => (current - 1 + OFF_STATE_EXAMPLES.length) % OFF_STATE_EXAMPLES.length,
            )
          }
          onNext={() => setExampleIndex((current) => (current + 1) % OFF_STATE_EXAMPLES.length)}
          t={t}
          format={format}
          locale={locale}
        />
      </section>
      <p className="mt-[18px] text-ui leading-5 text-muted-foreground">
        {t("settings.history.off.privacy")}{" "}
        <ComputerHistoryLearnMore
          label={t("settings.history.learnMore")}
          testId="computer-history-off-learn-more"
        />
      </p>
    </div>
  );
}

function PermissionModeSelect({
  mode,
  kind,
  disabled = false,
  onChange,
  t,
}: {
  mode: PermissionMode;
  kind: "apps" | "websites";
  disabled?: boolean;
  onChange: (mode: PermissionMode) => void;
  t: (key: TranslationKey) => string;
}) {
  const [open, setOpen] = useState(false);
  const label =
    kind === "apps"
      ? mode === "allow"
        ? t("settings.history.permissionMode.excludeApps")
        : t("settings.history.permissionMode.includeApps")
      : mode === "allow"
        ? t("settings.history.permissionMode.excludeWebsites")
        : t("settings.history.permissionMode.includeWebsites");
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <Button
            disabled={disabled}
            variant="ghost"
            size="xs"
            className="-ms-2 w-fit justify-start gap-[7px] self-start border-0 px-2 !text-ui-lg !leading-5 !font-medium tracking-normal"
            aria-label={
              kind === "apps" ? t("settings.history.applications") : t("settings.history.websites")
            }
            aria-haspopup="menu"
          />
        }
      >
        {label}
        <ComputerHistoryChevronDownIcon
          className="size-4 text-muted-foreground"
          aria-hidden="true"
        />
      </MenuTrigger>
      <ComposerPickerMenuPopup
        align="start"
        side="bottom"
        sideOffset={1}
        className="computer-history-menu min-w-[220px]"
      >
        <MenuRadioGroup
          value={mode}
          onValueChange={(value) => {
            onChange(value as PermissionMode);
            setOpen(false);
          }}
        >
          <MenuRadioItem value="allow" disabled={disabled}>
            {kind === "apps"
              ? t("settings.history.permissionMode.excludeApps")
              : t("settings.history.permissionMode.excludeWebsites")}
          </MenuRadioItem>
          <MenuRadioItem value="include" disabled={disabled}>
            {kind === "apps"
              ? t("settings.history.permissionMode.includeApps")
              : t("settings.history.permissionMode.includeWebsites")}
          </MenuRadioItem>
        </MenuRadioGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

function PermissionRuleRow({
  label,
  subtitle,
  icon,
  removeLabel,
  onRemove,
}: {
  label: string;
  subtitle?: string | undefined;
  icon: ReactNode;
  removeLabel: string;
  onRemove: () => void;
}) {
  return (
    <div className="group/permission grid min-h-10 shrink-0 grid-cols-[24px_minmax(0,1fr)_24px] items-center gap-2.5 rounded-lg px-2 py-1.5 text-ui leading-[17px] hover:bg-secondary/50 focus-within:bg-secondary/50">
      {icon}
      <div className="flex min-w-0 flex-col">
        <span className="truncate">{label}</span>
        {subtitle ? (
          <span className="truncate text-ui-xs leading-[15px] text-muted-foreground">
            {subtitle}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        className="inline-flex size-6 items-center justify-center rounded-lg text-muted-foreground opacity-0 transition-opacity duration-150 group-focus-within/permission:opacity-100 group-hover/permission:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring hover:text-foreground"
        aria-label={removeLabel}
        onClick={onRemove}
      >
        <ComputerHistoryRemoveIcon className="size-3" aria-hidden="true" />
      </button>
    </div>
  );
}

function AppPicker({
  applications,
  selected,
  query,
  loading,
  error,
  anchorElement,
  portalContainer,
  onQueryChange,
  onSelect,
  onDismiss,
  t,
}: {
  applications: readonly ComputerHistoryApp[];
  selected: readonly string[];
  query: string;
  loading: boolean;
  error: string | null;
  anchorElement: HTMLButtonElement | null;
  portalContainer: HTMLElement | null;
  onQueryChange: (query: string) => void;
  onSelect: (app: ComputerHistoryApp) => void;
  onDismiss: () => void;
  t: (key: TranslationKey) => string;
}) {
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    maxHeight: number;
  } | null>(null);
  const unselected = applications.filter((app) => !selected.includes(app.bundleIdentifier));
  const filtered = unselected.filter((app) => {
    const normalizedQuery = query.trim().toLowerCase();
    return (
      normalizedQuery.length === 0 ||
      app.name.toLowerCase().includes(normalizedQuery) ||
      app.bundleIdentifier.toLowerCase().includes(normalizedQuery)
    );
  });
  const activeOption = filtered[activeIndex];
  const activeOptionId = activeOption
    ? `computer-history-app-option-${activeOption.bundleIdentifier.replace(/[^a-zA-Z0-9_-]/gu, "-")}`
    : undefined;
  useEffect(() => {
    setActiveIndex(-1);
  }, [query, filtered.length]);
  useEffect(() => {
    if (activeIndex < 0) return;
    const activeElement = document.getElementById(activeOptionId ?? "");
    if (activeElement && typeof activeElement.scrollIntoView === "function") {
      activeElement.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, activeOptionId]);
  useEffect(() => {
    const updatePosition = () => {
      if (!anchorElement || !portalContainer) {
        setPosition(null);
        return;
      }
      const rect = anchorElement.getBoundingClientRect();
      const containingBlock = portalContainer.getBoundingClientRect();
      const collisionPadding = 6;
      const availableBelow = Math.max(0, window.innerHeight - rect.bottom - 1 - collisionPadding);
      const availableAbove = Math.max(0, rect.top - 1 - collisionPadding);
      const opensBelow = availableBelow >= 350 || availableBelow >= availableAbove;
      const maxHeight = Math.min(350, Math.max(1, opensBelow ? availableBelow : availableAbove));
      const popupWidth = 240;
      const left = Math.min(
        Math.max(rect.left, collisionPadding),
        Math.max(collisionPadding, window.innerWidth - popupWidth - collisionPadding),
      );
      setPosition({
        left: left - containingBlock.left,
        top:
          (opensBelow ? rect.bottom + 1 : Math.max(collisionPadding, rect.top - maxHeight - 1)) -
          containingBlock.top,
        maxHeight,
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [anchorElement, portalContainer]);
  if (position === null || portalContainer === null || typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed z-50 m-px flex w-[240px] select-none flex-col overflow-y-auto rounded-xl bg-[var(--color-surface-elevated-secondary)]/90 px-1 py-1 text-[var(--color-text-foreground)] shadow-[0_0_0_0.5px_var(--color-border),0_8px_16px_-4px_#0000001f] ring-[0.5px] ring-border backdrop-blur-sm max-h-[min(350px,calc(100vh-16px))]"
      style={{ left: position.left, top: position.top, maxHeight: position.maxHeight }}
      role="listbox"
      aria-label={t("settings.history.searchApps")}
      aria-activedescendant={activeOptionId}
      data-computer-history-permission-popover
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onDismiss();
        } else if (event.key === "ArrowDown" && filtered.length > 0) {
          event.preventDefault();
          setActiveIndex((current) =>
            current < 0 ? 0 : Math.min(current + 1, filtered.length - 1),
          );
        } else if (event.key === "ArrowUp" && filtered.length > 0) {
          event.preventDefault();
          setActiveIndex((current) =>
            current < 0 ? filtered.length - 1 : Math.max(current - 1, 0),
          );
        } else if (event.key === "Enter" && filtered[activeIndex]) {
          event.preventDefault();
          onSelect(filtered[activeIndex]);
        }
      }}
    >
      <div className="flex w-full items-center gap-1.5 px-2 py-1">
        <ComputerHistorySearchIcon
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          autoFocus
          type="text"
          role="searchbox"
          unstyled
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t("settings.history.searchApps")}
          aria-label={t("settings.history.searchApps")}
          className="!flex-1 !w-auto !min-w-0 !rounded-none !border-0 !bg-transparent !px-0 !py-0 !text-ui !leading-[17px] !outline-none"
        />
      </div>
      <div className="flex flex-col pb-1">
        {loading ? (
          <p className="px-2 py-3 text-ui-sm text-muted-foreground">
            {t("settings.history.loadingApps")}
          </p>
        ) : null}
        {error ? (
          <p className="px-2 py-3 text-ui-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {!loading && !error && filtered.length === 0 ? (
          <p className="px-2 py-3 text-ui-sm text-muted-foreground">
            {unselected.length === 0
              ? t("settings.history.allAppsAdded")
              : t("settings.history.noApps")}
          </p>
        ) : null}
        {!loading && !error
          ? filtered.map((app, filteredIndex) => (
              <button
                key={app.bundleIdentifier}
                type="button"
                role="option"
                id={`computer-history-app-option-${app.bundleIdentifier.replace(/[^a-zA-Z0-9_-]/gu, "-")}`}
                aria-selected={false}
                tabIndex={-1}
                className="flex w-full items-center gap-2.5 rounded-lg px-2 py-[5px] text-left text-ui leading-[17px] outline-none hover:bg-secondary/50 focus-visible:bg-secondary/50 data-[active=true]:bg-secondary/50"
                data-active={activeIndex === filteredIndex ? "true" : undefined}
                onClick={() => onSelect(app)}
              >
                <AppIcon name={app.name} iconDataURL={app.iconDataURL} />
                <span className="min-w-0 flex-1 truncate">{app.name}</span>
              </button>
            ))
          : null}
      </div>
    </div>,
    portalContainer,
  );
}

function HistoryApplicationChip({
  application,
  iconDataURL,
  excluded,
  disabled,
  menuAriaLabel,
  onMouseEnter,
  onMouseLeave,
  onClick,
}: {
  application: { readonly bundleIdentifier: string; readonly displayName: string };
  iconDataURL?: string | undefined;
  excluded: boolean;
  disabled: boolean;
  menuAriaLabel: string;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "size-5 overflow-hidden rounded-inline transition-opacity duration-[120ms] ease-in-out aria-disabled:!opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        excluded && "grayscale",
        disabled && "opacity-40",
      )}
      aria-label={menuAriaLabel}
      title={application.displayName}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
    >
      <AppIcon
        name={application.displayName}
        iconDataURL={iconDataURL}
        className="size-full rounded-none text-ui-2xs"
      />
    </button>
  );
}

export function ComputerHistorySettingsPanel() {
  const { handleNewChat } = useHandleNewChat();
  const { t, format, locale } = useTranslation();
  const [state, setState] = useState<ComputerHistoryState | null>(null);
  const [entries, setEntries] = useState<ComputerHistoryTimelineEntry[]>([]);
  const [settings, setSettings] = useState<ComputerHistorySettings>(DEFAULT_SETTINGS);
  const [error, setError] = useState<string | null>(null);
  const [stateError, setStateError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [consentOpen, setConsentOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [permissionInitialSetup, setPermissionInitialSetup] = useState(false);
  const [pendingConsentAt, setPendingConsentAt] = useState<string | null>(null);
  const [permissionLoading, setPermissionLoading] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [permissionLoadError, setPermissionLoadError] = useState<string | null>(null);
  const [permissionSaving, setPermissionSaving] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [applications, setApplications] = useState<ComputerHistoryApp[]>([]);
  const [resolvedApplications, setResolvedApplications] = useState<ComputerHistoryApp[]>([]);
  const [applicationsCatalogLoaded, setApplicationsCatalogLoaded] = useState(false);
  const [permissionSearch, setPermissionSearch] = useState("");
  const [appMode, setAppMode] = useState<PermissionMode>("allow");
  const [urlMode, setUrlMode] = useState<PermissionMode>("allow");
  const [appRules, setAppRules] = useState<string[]>([]);
  const [urlRules, setUrlRules] = useState<string[]>([]);
  const [urlDraft, setUrlDraft] = useState("");
  const [appPickerOpen, setAppPickerOpen] = useState(false);
  const [websiteDraftOpen, setWebsiteDraftOpen] = useState(false);
  const [collapsedDays, setCollapsedDays] = useState<Set<string>>(new Set());
  const [hoveredEntryId, setHoveredEntryId] = useState<string | null>(null);
  const [deleteEntryId, setDeleteEntryId] = useState<string | null>(null);
  const [appMenuTarget, setAppMenuTarget] = useState<{
    readonly entryId: string;
    readonly bundleIdentifier: string;
  } | null>(null);
  const [clearMenuOpen, setClearMenuOpen] = useState(false);
  const [clearConfirmScope, setClearConfirmScope] = useState<ComputerHistoryClearScope | null>(
    null,
  );
  const [highlightedApp, setHighlightedApp] = useState<string | null>(null);
  const [mutationPending, setMutationPending] = useState(false);
  const appPickerAnchorRef = useRef<HTMLButtonElement | null>(null);
  const [permissionDialogElement, setPermissionDialogElement] = useState<HTMLDivElement | null>(
    null,
  );
  const hoverClearTimeoutRef = useRef<number | null>(null);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const closeAppPicker = useCallback(() => {
    setAppPickerOpen(false);
  }, []);
  const dismissAppPicker = useCallback(() => {
    closeAppPicker();
    window.setTimeout(() => appPickerAnchorRef.current?.focus(), 0);
  }, [closeAppPicker]);

  const refresh = useCallback(
    (options: { readonly silent?: boolean } = {}): Promise<void> => {
      const existing = refreshInFlightRef.current;
      if (existing) return existing;
      const silent = options.silent === true;
      const request = (async () => {
        if (!silent) setLoading(true);
        try {
          const api = ensureNativeApi().computerHistory;
          if (!api) throw new Error("missing-computer-history-api");
          const nextState = await api.getState();
          setState(nextState);
          setSettings(nextState.settings);
          setStateError(null);
          if (!nextState.supported || !nextState.enabled) {
            setEntries([]);
            setHistoryError(null);
            setHistoryLoading(false);
          } else {
            setHistoryLoading(true);
            try {
              const history = await api.listHistory({ limit: 200 });
              setEntries([...history.entries]);
              setHistoryError(null);
            } catch {
              setEntries([]);
              setHistoryError(t("settings.history.error.historyLoad"));
            } finally {
              setHistoryLoading(false);
            }
          }
        } catch {
          if (!silent) setStateError(t("settings.history.error.load"));
          setHistoryError(null);
        } finally {
          if (!silent) setLoading(false);
        }
      })();
      refreshInFlightRef.current = request;
      void request.then(
        () => {
          if (refreshInFlightRef.current === request) refreshInFlightRef.current = null;
        },
        () => {
          if (refreshInFlightRef.current === request) refreshInFlightRef.current = null;
        },
      );
      return request;
    },
    [t],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onFocus = () => void refresh({ silent: true });
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  useEffect(() => {
    if (!state?.enabled) return;
    const activationPending =
      state.activationState === "starting" || state.activationState === "waiting_for_permissions";
    const timer = window.setInterval(
      () => void refresh({ silent: true }),
      activationPending ? 1_000 : 10_000,
    );
    return () => window.clearInterval(timer);
  }, [refresh, state?.activationState, state?.enabled]);

  const supported = state?.supported === true;
  const enabled = state?.enabled === true;
  const timelineGroups = useMemo(() => timelineDayGroups(entries), [entries]);
  const permissionApplications = useMemo(() => {
    const byId = new Map<string, ComputerHistoryApp>();
    for (const app of [...applications, ...resolvedApplications])
      byId.set(app.bundleIdentifier, app);
    return [...byId.values()];
  }, [applications, resolvedApplications]);
  const selectedWebsiteCount = urlRules.length;
  const selectedPermissionCount =
    (settings.observation.defaultApplicationBehavior === "allow"
      ? settings.observation.blocklist
      : settings.observation.allowlist
    ).length +
    (settings.observation.defaultURLBehavior === "allow"
      ? settings.observation.urlBlocklist
      : settings.observation.urlAllowlist
    ).length;

  useEffect(() => {
    if (!enabled) setHistoryLoading(false);
  }, [enabled]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (appPickerOpen) {
        event.preventDefault();
        dismissAppPicker();
        return;
      }
      setWebsiteDraftOpen(false);
      setAppMenuTarget(null);
      setHighlightedApp(null);
      setClearMenuOpen(false);
      setDeleteEntryId(null);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (appPickerOpen && !target.closest("[data-computer-history-permission-popover]")) {
        closeAppPicker();
        const focusTarget = target.closest<HTMLElement>(
          "button, [role=button], input, [role=combobox]",
        );
        focusTarget?.focus();
      }
      if (!target.closest("[data-computer-history-website-editor]")) setWebsiteDraftOpen(false);
      if (
        !target.closest("[data-computer-history-clear-menu]") &&
        !target.closest('[data-slot="menu-popup"]')
      ) {
        setClearMenuOpen(false);
      }
      if (!target.closest("[data-chronicle-delete-confirming=true]")) setDeleteEntryId(null);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [
    appPickerOpen,
    websiteDraftOpen,
    appMenuTarget,
    clearMenuOpen,
    deleteEntryId,
    closeAppPicker,
    dismissAppPicker,
  ]);

  useEffect(() => {
    return () => {
      if (hoverClearTimeoutRef.current !== null) window.clearTimeout(hoverClearTimeoutRef.current);
    };
  }, []);

  const syncPermissionDraft = (nextSettings: ComputerHistorySettings) => {
    const observation = nextSettings.observation;
    setAppMode(observation.defaultApplicationBehavior === "allow" ? "allow" : "include");
    setUrlMode(observation.defaultURLBehavior === "allow" ? "allow" : "include");
    setAppRules(
      observation.defaultApplicationBehavior === "allow"
        ? [...observation.blocklist]
        : [...observation.allowlist],
    );
    setUrlRules(
      observation.defaultURLBehavior === "allow"
        ? [...observation.urlBlocklist]
        : [...observation.urlAllowlist],
    );
  };

  const openPermissions = async (
    settingsForDraft: ComputerHistorySettings = settings,
    options: { readonly initialSetup?: boolean } = {},
  ) => {
    void settingsForDraft;
    setPermissionsOpen(true);
    setPermissionInitialSetup(options.initialSetup === true);
    setPermissionSearch("");
    setUrlDraft("");
    setAppPickerOpen(false);
    setWebsiteDraftOpen(false);
    setPermissionError(null);
    setPermissionLoadError(null);
    setPermissionLoading(true);
    try {
      const api = ensureNativeApi().computerHistory;
      if (!api) throw new Error("missing-computer-history-api");
      const latestSettings = await api.getSettings({});
      setSettings(latestSettings);
      syncPermissionDraft(latestSettings);
      const selected = [
        ...latestSettings.observation.allowlist,
        ...latestSettings.observation.blocklist,
      ];
      const resolved = await api.resolveApplications({
        bundleIdentifiers: [...new Set(selected)],
      });
      setResolvedApplications([...resolved.applications]);
    } catch (cause) {
      const code = extractComputerHistoryErrorCode(cause);
      setPermissionLoadError(
        `${t("settings.history.error.permissionsLoad")}${code ? ` (error ${code})` : ""}.`,
      );
    } finally {
      setPermissionLoading(false);
    }
  };

  const loadApplicationCatalog = async () => {
    if (applicationsCatalogLoaded) return;
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const api = ensureNativeApi().computerHistory;
      if (!api) throw new Error("missing-computer-history-api");
      setApplications([...(await api.listApplications()).applications]);
      setApplicationsCatalogLoaded(true);
    } catch {
      setCatalogError(t("settings.history.error.applications"));
    } finally {
      setCatalogLoading(false);
    }
  };

  const closePermissions = () => {
    setPermissionsOpen(false);
    setPermissionInitialSetup(false);
    setPendingConsentAt(null);
    setPermissionSearch("");
    setUrlDraft("");
    setAppPickerOpen(false);
    setWebsiteDraftOpen(false);
    setPermissionError(null);
    setPermissionLoadError(null);
    syncPermissionDraft(settings);
  };

  const savePermissions = async () => {
    if (permissionSaving) return;
    setPermissionSaving(true);
    try {
      const api = ensureNativeApi().computerHistory;
      if (!api) throw new Error("missing-computer-history-api");
      const nextSettings: ComputerHistorySettings = {
        ...settings,
        consentAt: pendingConsentAt ?? settings.consentAt,
        observation: {
          ...settings.observation,
          defaultApplicationBehavior: appMode === "allow" ? "allow" : "block",
          allowlist: appMode === "include" ? [...appRules] : [],
          blocklist: appMode === "allow" ? [...appRules] : [],
          defaultURLBehavior: urlMode === "allow" ? "allow" : "block",
          urlAllowlist: urlMode === "include" ? [...urlRules] : [],
          urlBlocklist: urlMode === "allow" ? [...urlRules] : [],
        },
      };
      const updated = await api.updateSettings({ settings: nextSettings });
      let nextState = updated;
      if (permissionInitialSetup) {
        nextState = await api.setEnabled(
          pendingConsentAt === null
            ? { enabled: true }
            : { enabled: true, consentAt: pendingConsentAt },
        );
      }
      setState(nextState);
      setSettings(nextState.settings);
      closePermissions();
      setPermissionError(null);
      await refresh();
    } catch {
      toastManager.add({ type: "error", title: t("settings.history.error.policy") });
    } finally {
      setPermissionSaving(false);
    }
  };

  const enableWithConsent = async (choice: "allow" | "customize") => {
    if (mutationPending) return;
    setMutationPending(true);
    try {
      const api = ensureNativeApi().computerHistory;
      if (!api) throw new Error("missing-computer-history-api");
      const consentAt = new Date().toISOString();
      if (choice === "customize") {
        setConsentOpen(false);
        setPendingConsentAt(consentAt);
        await openPermissions(settings, { initialSetup: true });
        return;
      }
      const consentSettings: ComputerHistorySettings = {
        ...settings,
        consentAt,
        observation: {
          ...settings.observation,
          defaultApplicationBehavior: "allow",
          allowlist: [],
          blocklist: [],
        },
      };
      const updated = await api.updateSettings({ settings: consentSettings });
      const nextState = await api.setEnabled({ enabled: true, consentAt });
      setState(nextState);
      setSettings(updated.settings ?? nextState.settings);
      setConsentOpen(false);
      setPendingConsentAt(null);
      setError(null);
      await refresh();
    } catch {
      toastManager.add({
        type: "error",
        title: t(
          choice === "allow" ? "settings.history.error.turnOn" : "settings.history.error.enable",
        ),
      });
    } finally {
      setMutationPending(false);
    }
  };

  const setEnabled = async (nextEnabled: boolean) => {
    if (mutationPending) return;
    setMutationPending(true);
    try {
      const api = ensureNativeApi().computerHistory;
      if (!api) throw new Error("missing-computer-history-api");
      const next = await api.setEnabled({ enabled: nextEnabled });
      setState(next);
      setSettings(next.settings);
      setError(null);
      await refresh();
    } catch {
      toastManager.add({
        type: "error",
        title: t(nextEnabled ? "settings.history.error.turnOn" : "settings.history.error.turnOff"),
      });
    } finally {
      setMutationPending(false);
    }
  };

  const toggleRecorder = async () => {
    if (mutationPending) return;
    setMutationPending(true);
    try {
      const api = ensureNativeApi().computerHistory;
      if (!api) throw new Error("missing-computer-history-api");
      const next = state?.recorderState === "paused" ? await api.resume() : await api.pause();
      setState(next);
      setSettings(next.settings);
      setError(null);
      await refresh({ silent: true });
    } catch {
      toastManager.add({ type: "error", title: t("settings.history.error.recorder") });
    } finally {
      setMutationPending(false);
    }
  };

  const retryActivation = async () => {
    if (mutationPending) return;
    setMutationPending(true);
    try {
      const api = ensureNativeApi().computerHistory;
      if (!api) throw new Error("missing-computer-history-api");
      const next = await api.retryActivation();
      setState(next);
      setSettings(next.settings);
      setError(null);
      await refresh({ silent: true });
    } catch {
      toastManager.add({ type: "error", title: t("settings.history.error.resume") });
    } finally {
      setMutationPending(false);
    }
  };

  const clearScope = async (scope: ComputerHistoryClearScope) => {
    if (mutationPending) return;
    setMutationPending(true);
    try {
      const api = ensureNativeApi().computerHistory;
      if (!api) throw new Error("missing-computer-history-api");
      await api.clearHistory({ scope });
      setClearConfirmScope(null);
      setClearMenuOpen(false);
      const message = t("settings.history.clearSuccess");
      toastManager.add({ type: "success", title: message });
      await refresh();
    } catch {
      toastManager.add({ type: "error", title: t("settings.history.error.clear") });
    } finally {
      setMutationPending(false);
    }
  };

  const deleteEntry = async (entry: ComputerHistoryTimelineEntry) => {
    if (mutationPending) return;
    setMutationPending(true);
    try {
      const api = ensureNativeApi().computerHistory;
      if (!api) throw new Error("missing-computer-history-api");
      await api.clearHistory({
        scope: "last_10m",
        intervalStartMs: entry.interval.startMs,
        intervalEndMs: entry.interval.endMs,
      });
      setDeleteEntryId(null);
      await refresh();
    } catch {
      toastManager.add({ type: "error", title: t("settings.history.error.delete") });
    } finally {
      setMutationPending(false);
    }
  };

  const updateFutureAppRule = async (
    entry: ComputerHistoryTimelineEntry,
    application: ComputerHistoryTimelineEntry["applications"][number],
    action: "include" | "exclude",
  ) => {
    if (mutationPending) return;
    setMutationPending(true);
    try {
      const api = ensureNativeApi().computerHistory;
      if (!api) throw new Error("missing-computer-history-api");
      const identifier = application.bundleIdentifier;
      const observation = settings.observation;
      const allowMode = observation.defaultApplicationBehavior === "allow";
      const nextSettings: ComputerHistorySettings = {
        ...settings,
        observation: {
          ...observation,
          allowlist:
            action === "include" && !allowMode
              ? [...new Set([...observation.allowlist, identifier])]
              : allowMode
                ? []
                : observation.allowlist.filter((item) => item !== identifier),
          blocklist:
            action === "exclude" && allowMode
              ? [...new Set([...observation.blocklist, identifier])]
              : !allowMode
                ? []
                : observation.blocklist.filter((item) => item !== identifier),
        },
      };
      const nextState = await api.updateSettings({ settings: nextSettings });
      setState(nextState);
      setSettings(nextState.settings);
      setAppMenuTarget(null);
    } catch {
      toastManager.add({ type: "error", title: t("settings.history.error.appPolicy") });
    } finally {
      setMutationPending(false);
    }
  };

  const askAbout = async (prompt: string, options: { readonly includeHistory?: boolean } = {}) => {
    try {
      const result = await handleNewChat({ fresh: true });
      if (!result.ok || !result.threadId) throw new Error("new-task-failed");
      const store = useComposerDraftStore.getState();
      if (options.includeHistory) {
        store.setPrompt(
          result.threadId,
          prompt.length > 0
            ? `${COMPUTER_HISTORY_MENTION_TOKEN} ${prompt}`
            : `${COMPUTER_HISTORY_MENTION_TOKEN} `,
        );
        store.setMentions(result.threadId, [COMPUTER_HISTORY_MENTION_REFERENCE]);
      } else {
        store.setPrompt(result.threadId, prompt);
      }
    } catch {
      setError(t("settings.history.error.newTask"));
    }
  };

  const askAboutHistory = async () => {
    const index = Math.min(
      ASK_ABOUT_HISTORY_PROMPTS.length - 1,
      Math.floor(Math.random() * ASK_ABOUT_HISTORY_PROMPTS.length),
    );
    await askAbout(ASK_ABOUT_HISTORY_PROMPTS[index]!, { includeHistory: true });
  };

  const renderPermissionsModal = () => {
    return (
      <ComputerHistoryModal
        open={permissionsOpen}
        title={t("settings.history.permissionsDialog")}
        onClose={closePermissions}
        size="xwide"
        onPopupElement={setPermissionDialogElement}
      >
        {permissionLoading ? (
          <div className="py-16 text-center text-ui-lg text-muted-foreground">
            {t("settings.history.loadingPermissions")}
          </div>
        ) : permissionLoadError ? (
          <div className="flex min-h-[300px] flex-col items-center justify-center gap-3 text-center text-ui-lg">
            <div className="flex flex-col gap-1">
              <p className="text-destructive" role="alert">
                {permissionLoadError}
              </p>
              <p className="text-muted-foreground">{t("settings.history.permissionsRestart")}</p>
            </div>
            <Button
              variant="outline"
              className={COMPUTER_HISTORY_DEFAULT_BUTTON_CLASS_NAME}
              onClick={() => void openPermissions()}
            >
              {t("settings.history.tryAgain")}
            </Button>
          </div>
        ) : (
          <>
            <div className="grid min-h-0 grid-cols-2 gap-3 max-sm:grid-cols-1">
              <section
                className="flex min-h-0 min-w-0 flex-col gap-2"
                aria-label={t("settings.history.applications")}
              >
                <PermissionModeSelect
                  mode={appMode}
                  kind="apps"
                  disabled={permissionSaving || permissionLoading}
                  onChange={(next) => {
                    setAppMode(next);
                  }}
                  t={t}
                />
                <div className="relative flex h-[250px] min-h-0 min-w-0 flex-col overflow-visible rounded-xl border border-border bg-foreground/[0.025]">
                  <div className="relative">
                    <Button
                      ref={appPickerAnchorRef}
                      variant="ghost"
                      size="sm"
                      className="mx-1 mt-1 !h-10 w-[calc(100%-0.5rem)] justify-start !gap-2.5 border-0 !px-2 text-[var(--color-text-foreground)]"
                      onClick={() => {
                        const nextOpen = !appPickerOpen;
                        setAppPickerOpen(nextOpen);
                        if (nextOpen) void loadApplicationCatalog();
                      }}
                      aria-expanded={appPickerOpen}
                      disabled={permissionSaving || catalogLoading}
                    >
                      <span className="flex size-6 items-center justify-center text-muted-foreground">
                        <ComputerHistoryPlusIcon className="size-4" aria-hidden="true" />
                      </span>
                      {t("settings.history.addApp")}
                    </Button>
                  </div>
                  {appPickerOpen ? (
                    <AppPicker
                      applications={permissionApplications}
                      selected={appRules}
                      query={permissionSearch}
                      loading={catalogLoading}
                      error={catalogError}
                      anchorElement={appPickerAnchorRef.current}
                      portalContainer={permissionDialogElement}
                      onQueryChange={setPermissionSearch}
                      onSelect={(app) => {
                        setAppRules((current) => [...new Set([...current, app.bundleIdentifier])]);
                        setPermissionSearch("");
                        closeAppPicker();
                        setPermissionError(null);
                      }}
                      onDismiss={dismissAppPicker}
                      t={t}
                    />
                  ) : null}
                  <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-1">
                    {appRules.length > 0
                      ? appRules.map((bundleIdentifier) => {
                          const app = permissionApplications.find(
                            (candidate) => candidate.bundleIdentifier === bundleIdentifier,
                          );
                          const appLabel = app?.name ?? fallbackApplicationName(bundleIdentifier);
                          return (
                            <PermissionRuleRow
                              key={bundleIdentifier}
                              label={appLabel}
                              subtitle={
                                browserPermissionSubtitle(
                                  app?.isWebBrowser === true,
                                  appMode === "include" ? "block" : "allow",
                                  urlMode === "include" ? "block" : "allow",
                                  selectedWebsiteCount,
                                  (key, values) => (values ? format(key, values) : t(key)),
                                ) ?? undefined
                              }
                              icon={<AppIcon name={appLabel} iconDataURL={app?.iconDataURL} />}
                              removeLabel={format("settings.history.removeRule", {
                                value: appLabel,
                              })}
                              onRemove={() =>
                                setAppRules((current) =>
                                  current.filter((item) => item !== bundleIdentifier),
                                )
                              }
                            />
                          );
                        })
                      : null}
                  </div>
                </div>
              </section>

              <section
                className="flex min-h-0 min-w-0 flex-col gap-2"
                aria-label={t("settings.history.websites")}
              >
                <PermissionModeSelect
                  mode={urlMode}
                  kind="websites"
                  disabled={permissionSaving || permissionLoading}
                  onChange={(next) => {
                    setUrlMode(next);
                  }}
                  t={t}
                />
                <div
                  className="relative flex h-[250px] min-h-0 min-w-0 flex-col overflow-visible rounded-xl border border-border bg-foreground/[0.025]"
                  data-computer-history-website-editor
                >
                  <div className="relative">
                    {!websiteDraftOpen ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="mx-1 mt-1 !h-10 w-[calc(100%-0.5rem)] justify-start !gap-2.5 border-0 !px-2 text-[var(--color-text-foreground)]"
                        onClick={() => setWebsiteDraftOpen(true)}
                        disabled={permissionSaving}
                      >
                        <span className="flex size-6 items-center justify-center text-muted-foreground">
                          <ComputerHistoryPlusIcon className="size-4" aria-hidden="true" />
                        </span>
                        {t("settings.history.addWebsite")}
                      </Button>
                    ) : (
                      <form
                        className="flex min-h-10 items-center gap-2 rounded-lg bg-foreground/[0.025] px-2"
                        onKeyDown={(event) => {
                          if (event.key !== "Escape") return;
                          event.preventDefault();
                          event.stopPropagation();
                          setWebsiteDraftOpen(false);
                        }}
                        onSubmit={(event) => {
                          event.preventDefault();
                          const host = normalizeHostInput(urlDraft);
                          if (!host) {
                            setPermissionError(t("settings.history.invalidWebsite"));
                            return;
                          }
                          setUrlRules((current) =>
                            current.includes(host) ? current : [...current, host],
                          );
                          setUrlDraft("");
                          setPermissionError(null);
                          setWebsiteDraftOpen(false);
                        }}
                      >
                        <ComputerHistoryGlobeIcon
                          className="size-4 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <Input
                          autoFocus
                          value={urlDraft}
                          onChange={(event) => setUrlDraft(event.target.value)}
                          placeholder={t("settings.history.websiteExample")}
                          aria-label={t("settings.history.websiteDomain")}
                          className="min-h-0 border-0 bg-transparent"
                        />
                        <Button
                          disabled={permissionSaving}
                          variant="secondary"
                          size="xs"
                          type="submit"
                        >
                          {t("settings.history.save")}
                        </Button>
                      </form>
                    )}
                  </div>
                  {permissionError && !permissionLoading && !appPickerOpen ? (
                    <p className="text-ui-sm text-destructive" role="alert">
                      {permissionError}
                    </p>
                  ) : null}
                  <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-1">
                    {urlRules.length > 0
                      ? urlRules.map((host) => (
                          <div key={host} data-testid="computer-history-website-rule">
                            <PermissionRuleRow
                              label={host}
                              icon={
                                <span className="flex size-6 items-center justify-center rounded-lg bg-foreground/5 text-muted-foreground">
                                  <ComputerHistoryGlobeIcon className="size-4" aria-hidden="true" />
                                </span>
                              }
                              removeLabel={format("settings.history.removeRule", { value: host })}
                              onRemove={() =>
                                setUrlRules((current) => current.filter((item) => item !== host))
                              }
                            />
                          </div>
                        ))
                      : null}
                  </div>
                </div>
              </section>
            </div>
            <p className="mt-3 text-ui-sm leading-[17px] text-muted-foreground">
              {t("settings.history.privateNoteShort")}{" "}
              <ComputerHistoryLearnMore
                label={t("settings.history.learnMorePrivacy")}
                testId="computer-history-permissions-learn-more"
              />
            </p>
            <div className="mt-3 flex justify-end gap-3">
              <Button
                disabled={permissionSaving}
                variant="ghost"
                className={COMPUTER_HISTORY_DIALOG_BUTTON_CLASS_NAME}
                onClick={closePermissions}
              >
                {t("settings.history.cancel")}
              </Button>
              <Button
                disabled={permissionSaving}
                aria-busy={permissionSaving}
                className={COMPUTER_HISTORY_DIALOG_BUTTON_CLASS_NAME}
                onClick={() => void savePermissions()}
              >
                {permissionSaving ? (
                  <LoaderIcon className="size-4 animate-spin" aria-hidden="true" />
                ) : null}
                {t(permissionInitialSetup ? "settings.history.continue" : "settings.history.done")}
              </Button>
            </div>
          </>
        )}
      </ComputerHistoryModal>
    );
  };

  const renderTimeline = () => {
    const historyTitle = (
      <span className="flex items-center gap-2">
        <span>{t("settings.history.historyTitle")}</span>
        <InfoTooltip
          label={t("settings.history.historyAbout")}
          description={t("settings.history.historyDescription")}
        />
      </span>
    );
    const clearMenu = (
      <div className="relative" data-computer-history-clear-menu>
        <Menu open={clearMenuOpen} onOpenChange={setClearMenuOpen}>
          <MenuTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                className={COMPUTER_HISTORY_CLEAR_BUTTON_CLASS_NAME}
                disabled={mutationPending}
                aria-expanded={clearMenuOpen}
                aria-haspopup="menu"
              />
            }
          >
            {t("settings.history.clearHistory")}
            <ComputerHistoryChevronDownIcon className="size-4" aria-hidden="true" />
          </MenuTrigger>
          <ComposerPickerMenuPopup
            align="end"
            side="bottom"
            sideOffset={1}
            className="computer-history-menu min-w-[220px]"
          >
            {(Object.keys(CLEAR_SCOPE_LABELS) as ComputerHistoryClearScope[]).map((scope) => (
              <MenuItem
                key={scope}
                disabled={mutationPending}
                aria-busy={mutationPending}
                variant={scope === "all" ? "destructive" : "default"}
                onClick={() => setClearConfirmScope(scope)}
              >
                {t(CLEAR_SCOPE_LABELS[scope])}
              </MenuItem>
            ))}
          </ComposerPickerMenuPopup>
        </Menu>
      </div>
    );
    const actions =
      entries.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {clearMenu}
          <Button
            variant="outline"
            size="sm"
            className={COMPUTER_HISTORY_TOOLBAR_BUTTON_CLASS_NAME}
            onClick={() => void askAboutHistory()}
          >
            <ComputerHistoryAskIcon className="size-4" aria-hidden="true" />
            {t("settings.history.askAboutHistory")}
          </Button>
        </div>
      ) : null;
    return (
      <section className="flex flex-col" data-testid="computer-history-history-section">
        <div className="flex min-h-toolbar items-center justify-between gap-4 pb-1.5">
          <h2 className="flex items-center gap-2 text-ui-lg leading-[18px] font-medium">
            {historyTitle}
          </h2>
          {actions}
        </div>
        <SettingsCard className="rounded-2xl bg-[var(--color-background-panel)]">
          {historyError ? (
            <div className="flex flex-col items-center gap-3 px-5 py-10 text-center text-ui-lg text-[var(--color-text-foreground-secondary)]">
              <p role="alert">{t("settings.history.error.historyLoad")}</p>
              <Button
                variant="outline"
                className={COMPUTER_HISTORY_DEFAULT_BUTTON_CLASS_NAME}
                onClick={() => void refresh()}
              >
                {t("settings.history.tryAgain")}
              </Button>
            </div>
          ) : historyLoading && timelineGroups.length === 0 ? (
            <div
              className="px-5 py-10 text-center text-ui-lg text-muted-foreground"
              data-testid="computer-history-timeline-loading"
            >
              {t("settings.history.loadingHistory")}
            </div>
          ) : timelineGroups.length === 0 ? (
            <div
              className="px-5 py-10 text-center text-ui-lg text-muted-foreground"
              data-testid="computer-history-empty"
            >
              {t("settings.history.noHistory")}
            </div>
          ) : (
            <div className="divide-y divide-border" data-testid="computer-history-timeline">
              {timelineGroups.map((group) => {
                const expanded = !collapsedDays.has(group.key);
                return (
                  <section key={group.key} className="px-5 py-4">
                    <button
                      type="button"
                      className="inline-flex items-center gap-2 text-left text-ui-lg font-medium outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
                      aria-expanded={expanded}
                      onClick={() =>
                        setCollapsedDays((current) => toggleTimelineCluster(current, group.key))
                      }
                    >
                      <span>
                        {dateHeading(group.entries[0]?.interval.startMs ?? Date.now(), t)}
                      </span>
                      <ComputerHistoryChevronRightIcon
                        className={cn(
                          "size-4 text-muted-foreground transition-transform",
                          expanded && "rotate-90",
                        )}
                        aria-hidden="true"
                      />
                    </button>
                    {expanded ? (
                      <div className="flex flex-col">
                        {group.entries.map((entry, entryIndex) => {
                          const previous = group.entries[entryIndex - 1];
                          const next = group.entries[entryIndex + 1];
                          const gap = timelineHasGap(previous, entry, next);
                          const confirming = deleteEntryId === entry.id;
                          const visible = hoveredEntryId === entry.id || confirming;
                          const entryHasHighlightedApp =
                            highlightedApp !== null &&
                            entry.applications.some(
                              (application) => application.bundleIdentifier === highlightedApp,
                            );
                          return (
                            <div
                              key={entry.id}
                              className="grid grid-cols-[68px_1px_minmax(0,1fr)] items-stretch gap-x-4"
                              data-testid="computer-history-entry"
                              data-history-summary-level={entry.summaryLevel}
                              data-history-interval-start={entry.interval.startMs}
                              data-history-interval-end={entry.interval.endMs}
                            >
                              {entry.summaryLevel === "six_hour" ? (
                                <Tooltip>
                                  <TooltipTrigger
                                    delay={700}
                                    render={
                                      <time
                                        className="pt-[14px] text-right text-ui-xs font-medium leading-4 tabular-nums text-muted-foreground"
                                        dateTime={new Date(entry.interval.startMs).toISOString()}
                                        data-history-time={entry.summaryLevel}
                                      />
                                    }
                                  >
                                    {formatTimelineEntryTime(entry, t)}
                                  </TooltipTrigger>
                                  <TooltipPopup
                                    side="top"
                                    sideOffset={2}
                                    className={COMPUTER_HISTORY_TOOLTIP_CLASS_NAME}
                                    viewportClassName={COMPUTER_HISTORY_TOOLTIP_VIEWPORT_CLASS_NAME}
                                  >
                                    {formatTimelineIntervalTooltip(entry)}
                                  </TooltipPopup>
                                </Tooltip>
                              ) : (
                                <time
                                  className="pt-[14px] text-right text-ui-xs font-medium leading-4 tabular-nums text-muted-foreground"
                                  dateTime={new Date(entry.interval.startMs).toISOString()}
                                  data-history-time={entry.summaryLevel}
                                >
                                  {formatTimelineEntryTime(entry, t)}
                                </time>
                              )}
                              <span
                                className={cn("relative min-h-full w-px")}
                                data-history-rail
                                data-history-rail-first={entryIndex === 0 ? "true" : undefined}
                                data-history-rail-last={
                                  entryIndex === group.entries.length - 1 ? "true" : undefined
                                }
                                data-history-gap-before={gap.before ? "true" : undefined}
                                data-history-gap-after={gap.after ? "true" : undefined}
                                aria-hidden="true"
                              >
                                <span
                                  className={cn(
                                    "absolute top-0 left-0 h-[17px] w-px bg-border",
                                    gap.before &&
                                      "bg-[repeating-linear-gradient(to_bottom,hsl(var(--muted-foreground)/.5)_0_2px,transparent_2px_5px)]",
                                    entryIndex === 0 && "hidden",
                                  )}
                                  data-history-rail-before="true"
                                />
                                <span
                                  className="absolute top-[19px] left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-muted-foreground"
                                  data-history-rail-dot="true"
                                />
                                <span
                                  className={cn(
                                    "absolute top-[27px] right-0 bottom-0 w-px bg-border",
                                    gap.after &&
                                      "bg-[repeating-linear-gradient(to_bottom,hsl(var(--muted-foreground)/.5)_0_2px,transparent_2px_5px)]",
                                    entryIndex === group.entries.length - 1 && "hidden",
                                  )}
                                  data-history-rail-after="true"
                                />
                              </span>
                              <article
                                className={cn(
                                  "group/timeline min-w-0 pl-0 pr-1 pt-3 transition-opacity duration-150 motion-reduce:transition-none",
                                  entryIndex === group.entries.length - 1
                                    ? "pb-[14px]"
                                    : "pb-[34px]",
                                  highlightedApp && !entryHasHighlightedApp && "opacity-40",
                                )}
                                data-history-entry-menu={entry.id}
                                onMouseEnter={() => {
                                  if (hoverClearTimeoutRef.current !== null) {
                                    window.clearTimeout(hoverClearTimeoutRef.current);
                                    hoverClearTimeoutRef.current = null;
                                  }
                                  setHoveredEntryId(entry.id);
                                }}
                                onMouseLeave={() => {
                                  if (!confirming && appMenuTarget?.entryId !== entry.id)
                                    hoverClearTimeoutRef.current = window.setTimeout(
                                      () => setHoveredEntryId(null),
                                      120,
                                    );
                                }}
                              >
                                <div className="flex min-w-0 items-center gap-2">
                                  <h3 className="min-w-0 truncate text-ui-lg leading-5 font-medium">
                                    {entry.title}
                                  </h3>
                                  <div
                                    className={cn(
                                      "flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-150 group-focus-within/timeline:opacity-100 group-hover/timeline:opacity-100 motion-reduce:transition-none",
                                      visible && "opacity-100",
                                    )}
                                  >
                                    <Tooltip>
                                      <TooltipTrigger
                                        delay={700}
                                        render={
                                          <button
                                            type="button"
                                            className="inline-flex size-5.5 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
                                            aria-label={format("settings.history.revealFinderFor", {
                                              title: entry.title,
                                            })}
                                            onClick={(event) => {
                                              event.currentTarget.blur();
                                              const api = ensureNativeApi().computerHistory;
                                              if (!api) return;
                                              void api.revealInFinder({ entryId: entry.id });
                                            }}
                                          >
                                            <ComputerHistoryFolderIcon
                                              className="size-4"
                                              aria-hidden="true"
                                            />
                                          </button>
                                        }
                                      />
                                      <TooltipPopup
                                        side="top"
                                        sideOffset={2}
                                        className={COMPUTER_HISTORY_TOOLTIP_CLASS_NAME}
                                        viewportClassName={
                                          COMPUTER_HISTORY_TOOLTIP_VIEWPORT_CLASS_NAME
                                        }
                                      >
                                        {t("settings.history.revealFinder")}
                                      </TooltipPopup>
                                    </Tooltip>
                                    <Tooltip disabled={confirming}>
                                      <TooltipTrigger
                                        delay={700}
                                        render={
                                          <button
                                            type="button"
                                            className={cn(
                                              "inline-flex h-5.5 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
                                              confirming
                                                ? "w-14 border border-destructive bg-destructive text-white hover:bg-destructive/90 hover:text-white"
                                                : "w-5.5",
                                            )}
                                            style={{
                                              transition:
                                                "width .16s cubic-bezier(.2,.8,.2,1), background-color .12s, color .12s, opacity .12s",
                                            }}
                                            disabled={mutationPending}
                                            aria-busy={mutationPending}
                                            data-chronicle-delete-confirming={
                                              confirming ? "true" : undefined
                                            }
                                            aria-label={format(
                                              confirming
                                                ? "settings.history.confirmDeleteItem"
                                                : "settings.history.deleteItem",
                                              { title: entry.title },
                                            )}
                                            onClick={() => {
                                              if (confirming) void deleteEntry(entry);
                                              else setDeleteEntryId(entry.id);
                                            }}
                                          >
                                            {confirming ? (
                                              t("settings.history.deleteConfirm")
                                            ) : (
                                              <ComputerHistoryTrashIcon
                                                className="size-4"
                                                aria-hidden="true"
                                              />
                                            )}
                                          </button>
                                        }
                                      />
                                      <TooltipPopup
                                        side="top"
                                        sideOffset={2}
                                        className={COMPUTER_HISTORY_TOOLTIP_CLASS_NAME}
                                        viewportClassName={
                                          COMPUTER_HISTORY_TOOLTIP_VIEWPORT_CLASS_NAME
                                        }
                                      >
                                        {t("settings.history.deleteTooltip")}
                                      </TooltipPopup>
                                    </Tooltip>
                                  </div>
                                </div>
                                <p className="mt-[3px] text-ui leading-5 text-muted-foreground">
                                  {entry.description}
                                </p>
                                {entry.applications.length > 0 ? (
                                  <div
                                    className="mt-2 flex flex-wrap items-center gap-[9px]"
                                    data-testid="computer-history-entry-apps"
                                  >
                                    {entry.applications.map((application) => {
                                      const menuOpen =
                                        appMenuTarget?.entryId === entry.id &&
                                        appMenuTarget.bundleIdentifier ===
                                          application.bundleIdentifier;
                                      const included = isComputerHistoryApplicationIncluded(
                                        settings,
                                        application.bundleIdentifier,
                                      );
                                      return (
                                        <Menu
                                          key={application.bundleIdentifier}
                                          open={menuOpen}
                                          onOpenChange={(open) => {
                                            if (open) {
                                              setHighlightedApp(application.bundleIdentifier);
                                              setAppMenuTarget({
                                                entryId: entry.id,
                                                bundleIdentifier: application.bundleIdentifier,
                                              });
                                            } else {
                                              setAppMenuTarget(null);
                                              setHighlightedApp(null);
                                            }
                                          }}
                                        >
                                          <MenuTrigger
                                            render={
                                              <HistoryApplicationChip
                                                application={application}
                                                iconDataURL={application.iconDataURL}
                                                excluded={!included}
                                                disabled={
                                                  highlightedApp != null &&
                                                  highlightedApp !== application.bundleIdentifier
                                                }
                                                menuAriaLabel={format(
                                                  "settings.history.openAppMenu",
                                                  {
                                                    app: application.displayName,
                                                  },
                                                )}
                                                onMouseEnter={() => {
                                                  if (hoverClearTimeoutRef.current !== null) {
                                                    window.clearTimeout(
                                                      hoverClearTimeoutRef.current,
                                                    );
                                                    hoverClearTimeoutRef.current = null;
                                                  }
                                                  setHighlightedApp(application.bundleIdentifier);
                                                }}
                                                onMouseLeave={() => {
                                                  if (!menuOpen) {
                                                    if (hoverClearTimeoutRef.current !== null)
                                                      window.clearTimeout(
                                                        hoverClearTimeoutRef.current,
                                                      );
                                                    hoverClearTimeoutRef.current =
                                                      window.setTimeout(
                                                        () => setHighlightedApp(null),
                                                        120,
                                                      );
                                                  }
                                                }}
                                                onClick={() => {}}
                                              />
                                            }
                                          />
                                          <ComposerPickerMenuPopup
                                            align="start"
                                            side="bottom"
                                            sideOffset={6}
                                            className="computer-history-menu !w-max !min-w-[180px]"
                                          >
                                            <MenuItem
                                              disabled={mutationPending}
                                              aria-busy={mutationPending}
                                              onClick={() =>
                                                void updateFutureAppRule(
                                                  entry,
                                                  application,
                                                  included ? "exclude" : "include",
                                                )
                                              }
                                            >
                                              {format(
                                                included
                                                  ? "settings.history.excludeApplication"
                                                  : "settings.history.includeApplication",
                                                { app: application.displayName },
                                              )}
                                            </MenuItem>
                                          </ComposerPickerMenuPopup>
                                        </Menu>
                                      );
                                    })}
                                  </div>
                                ) : null}
                                {entry.suggestion ? (
                                  <div
                                    className="mt-3 rounded-lg bg-foreground/5 px-3 py-2"
                                    data-testid="computer-history-inline-suggestion"
                                  >
                                    <p className="text-ui-lg leading-5 font-medium">
                                      {entry.suggestion.type === "skill"
                                        ? t("settings.history.suggestedSkill")
                                        : t("settings.history.suggestedAutomation")}
                                    </p>
                                    <p className="mt-1 text-ui-lg leading-5 text-muted-foreground">
                                      {entry.suggestion.description}
                                    </p>
                                    <button
                                      type="button"
                                      className="mt-1 text-ui-lg leading-5 text-primary underline-offset-2 hover:underline focus-visible:underline"
                                      onClick={() =>
                                        void askAbout(
                                          entry.suggestion?.type === "skill"
                                            ? `Create a new "${entry.suggestion.name}" skill based on the description below. Consult the memory at ${entry.memoryFilePath} and the events.jsonl files cited there to understand the recorded workflow and my actions.\n\n"${entry.suggestion.description}"`
                                            : `Create a new "${entry.suggestion?.name ?? ""}" automation based on the description below. Consult the memory at ${entry.memoryFilePath} and the events.jsonl files cited there to understand the recorded workflow and my actions.\n\n"${entry.suggestion?.description ?? ""}"\n\nUse my local timezone and a new chat for scheduled runs.`,
                                          { includeHistory: true },
                                        )
                                      }
                                    >
                                      {format(
                                        entry.suggestion.type === "skill"
                                          ? "settings.history.createSuggestedSkill"
                                          : "settings.history.createSuggestedAutomation",
                                        { name: entry.suggestion.name },
                                      )}
                                    </button>
                                  </div>
                                ) : null}
                              </article>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </section>
                );
              })}
            </div>
          )}
        </SettingsCard>
      </section>
    );
  };

  if (loading && !state) {
    return (
      <div
        className="px-5 py-10 text-center text-ui-lg text-muted-foreground"
        data-testid="computer-history-loading"
      >
        {t("settings.history.loadingSettings")}
      </div>
    );
  }

  if (!state) {
    return (
      <div
        className="flex flex-col items-center gap-3 px-5 py-10 text-center text-ui-lg text-muted-foreground"
        data-testid="computer-history-error"
      >
        <p>{stateError ?? t("settings.history.error.load")}</p>
        <Button
          variant="outline"
          className={COMPUTER_HISTORY_DEFAULT_BUTTON_CLASS_NAME}
          onClick={() => void refresh()}
        >
          {t("settings.history.tryAgain")}
        </Button>
      </div>
    );
  }

  if (!supported || !enabled) {
    return (
      <>
        {!supported ? (
          <p className="mb-4 text-ui-lg text-muted-foreground" role="status">
            {state.message ?? t("settings.history.unavailable")}
          </p>
        ) : null}
        <OffState
          disabled={!supported || mutationPending}
          disabledReason={state.message ?? t("settings.history.unavailable")}
          onTurnOn={() => setConsentOpen(true)}
          t={t}
          format={format}
          locale={locale}
        />
        <ComputerHistoryModal
          open={consentOpen}
          title={t("settings.history.consent.title")}
          onClose={() => setConsentOpen(false)}
        >
          <h2 className="text-base font-semibold">{t("settings.history.consent.title")}</h2>
          <ul className="mt-3 flex flex-col gap-3 text-ui-lg text-muted-foreground">
            <li className="flex items-start gap-3">
              <ComputerHistoryBookIcon
                className="size-6 shrink-0"
                aria-hidden="true"
                data-testid="computer-history-consent-controls-icon"
              />
              <span>{t("settings.history.consent.controls")}</span>
            </li>
            <li className="flex items-start gap-3">
              <ComputerHistoryClipboardIcon
                className="size-6 shrink-0"
                aria-hidden="true"
                data-testid="computer-history-consent-sensitive-icon"
              />
              <span>{t("settings.history.consent.sensitiveApps")}</span>
            </li>
            <li className="flex items-start gap-3">
              <ComputerHistoryPersonVideoIcon
                className="size-6 shrink-0"
                aria-hidden="true"
                data-testid="computer-history-consent-other-people-icon"
              />
              <span>{t("settings.history.consent.otherPeople")}</span>
            </li>
          </ul>
          <div className="mt-3 flex flex-wrap justify-end gap-3">
            <Button variant="ghost" onClick={() => setConsentOpen(false)}>
              {t("settings.history.cancel")}
            </Button>
            <Button
              disabled={mutationPending}
              variant="ghost"
              onClick={() => void enableWithConsent("allow")}
            >
              {t("settings.history.allowAllApps")}
            </Button>
            <Button disabled={mutationPending} onClick={() => void enableWithConsent("customize")}>
              {t("settings.history.customizeApps")}
            </Button>
          </div>
        </ComputerHistoryModal>
        {renderPermissionsModal()}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-8" data-testid="computer-history-settings">
      <div
        className="computer-history-settings-card flex flex-col overflow-hidden rounded-2xl border border-[var(--color-border)]"
        style={{
          backgroundColor:
            "var(--color-background-panel, var(--color-background-primary-soft-alpha))",
        }}
      >
        <ComputerHistorySettingsRow
          title={t("settings.history.title")}
          description={
            <>
              {t("settings.history.enableDescription")}{" "}
              <ComputerHistoryLearnMore
                label={t("settings.history.learnMore")}
                testId="computer-history-enabled-learn-more"
              />
            </>
          }
          control={
            <div className="flex items-center gap-2">
              {state.activationState === "waiting_for_permissions" ? (
                <Button
                  disabled={mutationPending}
                  variant="secondary"
                  size="sm"
                  className={COMPUTER_HISTORY_DEFAULT_BUTTON_CLASS_NAME}
                  onClick={() => void retryActivation()}
                >
                  {t("settings.history.finishSetup")}
                </Button>
              ) : state.activationState === "failed" ? (
                <Button
                  disabled={mutationPending}
                  variant="secondary"
                  size="sm"
                  className={COMPUTER_HISTORY_DEFAULT_BUTTON_CLASS_NAME}
                  onClick={() => void retryActivation()}
                >
                  {t("settings.history.tryAgain")}
                </Button>
              ) : state.activationState === "starting" ? (
                <Button
                  variant="secondary"
                  size="sm"
                  className={COMPUTER_HISTORY_DEFAULT_BUTTON_CLASS_NAME}
                  disabled
                  aria-busy="true"
                  data-testid="computer-history-resume-loading"
                >
                  <LoaderIcon className="size-4 animate-spin" aria-hidden="true" />
                  {t("settings.history.resume")}
                </Button>
              ) : state.recorderState === "running" || state.recorderState === "paused" ? (
                <Button
                  disabled={mutationPending}
                  variant="secondary"
                  size="sm"
                  className={COMPUTER_HISTORY_DEFAULT_BUTTON_CLASS_NAME}
                  onClick={() => void toggleRecorder()}
                >
                  {state.recorderState === "paused"
                    ? t("settings.history.resume")
                    : t("settings.history.pause")}
                </Button>
              ) : null}
              <Switch
                checked={enabled}
                disabled={mutationPending}
                onCheckedChange={(checked) => void setEnabled(Boolean(checked))}
                aria-label={t("settings.history.turnOffAriaLabel")}
              />
            </div>
          }
        />
        <ComputerHistorySettingsRow
          title={t("settings.history.permissions")}
          description={t("settings.history.permissionsDescription")}
          control={
            <Button
              disabled={mutationPending}
              variant="secondary"
              size="sm"
              className={COMPUTER_HISTORY_TOOLBAR_BUTTON_CLASS_NAME}
              onClick={() => void openPermissions()}
            >
              {selectedPermissionCount > 0
                ? format("settings.history.selectedCount", { count: selectedPermissionCount })
                : t("settings.history.choose")}
            </Button>
          }
        />
      </div>
      {renderTimeline()}
      {renderPermissionsModal()}
      <ComputerHistoryModal
        open={clearConfirmScope !== null}
        title={t("settings.history.clearDialog")}
        onClose={() => setClearConfirmScope(null)}
        showCloseButton
      >
        {clearConfirmScope ? (
          <>
            <h2 className="text-base font-semibold">
              {t(clearScopeQuestionKey(clearConfirmScope))}
            </h2>
            <p className="mt-1 text-ui-lg text-muted-foreground">
              {t("settings.history.clearDescription")}
            </p>
            <div className="mt-3 flex justify-end gap-3">
              <Button variant="ghost" onClick={() => setClearConfirmScope(null)}>
                {t("settings.history.cancel")}
              </Button>
              <Button
                disabled={mutationPending}
                aria-busy={mutationPending}
                variant="destructive"
                onClick={() => void clearScope(clearConfirmScope)}
              >
                {t("settings.history.clear")}
              </Button>
            </div>
          </>
        ) : null}
      </ComputerHistoryModal>
    </div>
  );
}
