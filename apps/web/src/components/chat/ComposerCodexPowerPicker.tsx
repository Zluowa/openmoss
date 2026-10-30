import { useReducedMotion } from "motion/react";
import {
  cloneElement,
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { ChevronRightIcon, FastModeIcon, FastModeOutlineIcon, RotateCcwIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { MenuCheckboxItem, MenuItem } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  COMPOSER_POWER_MIN_CHOICES,
  composerCodexPowerChoiceLabel,
  type ComposerCodexPowerChoice,
} from "./composerCodexPowerOptions";
import {
  ComposerCodexPowerSlider,
  type ComposerCodexPowerSliderChangeReason,
  type ComposerCodexPowerSliderOption,
} from "./ComposerCodexPowerSlider";

export type ComposerCodexPowerPickerProps = {
  readonly choices: ReadonlyArray<ComposerCodexPowerChoice>;
  readonly selectedIndex: number | null;
  readonly fallbackIndex: number | null;
  readonly fastModeEnabled: boolean;
  readonly fastModeAvailable?: boolean;
  readonly advancedContent: ReactNode;
  readonly onPowerChange: (choice: ComposerCodexPowerChoice) => void | Promise<void>;
  readonly onFastModeChange: (enabled: boolean) => void;
  readonly onAdvancedToggle?: () => void;
  readonly onReset?: (choice: ComposerCodexPowerChoice) => void | Promise<void>;
  readonly onRequestClose?: () => void;
  readonly onFocusTrigger?: () => void;
  readonly disabled?: boolean;
  /** The narrow composer omits the view-controls row when its trigger label is hidden. */
  readonly hideViewControls?: boolean;
  /**
   * Localized effort label for a choice. Defaults to Codex's Light/Standard/Extended
   * naming; other providers pass their own so the slider speaks that vendor's terms.
   */
  readonly localizeEffortLabel?: (choice: ComposerCodexPowerChoice) => string;
};

const POWER_EFFORT_TRANSLATION_KEYS: Partial<
  Record<string, Parameters<ReturnType<typeof useTranslation>["t"]>[0]>
> = {
  low: "chat.codexPower.light",
  medium: "chat.codexPower.standard",
  high: "chat.codexPower.extended",
  xhigh: "chat.codexPower.extraHigh",
  ultra: "chat.codexPower.ultra",
};

type MeasuredHeights = {
  compact: number;
  controls: number;
  advanced: number;
};

const INITIAL_HEIGHTS: MeasuredHeights = { compact: 0, controls: 0, advanced: 0 };
const POWER_ULTRA_WARNING_MS = 2_000;

function clampIndex(index: number, count: number): number {
  return Math.max(0, Math.min(count - 1, Math.round(index)));
}

function isHeightChange(previous: MeasuredHeights, next: MeasuredHeights): boolean {
  return (
    previous.compact !== next.compact ||
    previous.controls !== next.controls ||
    previous.advanced !== next.advanced
  );
}

function localizedChoiceLabel(
  choice: ComposerCodexPowerChoice,
  t: ReturnType<typeof useTranslation>["t"],
  localizeEffortLabel?: (choice: ComposerCodexPowerChoice) => string,
): string {
  if (localizeEffortLabel) {
    return composerCodexPowerChoiceLabel(choice, {
      [choice.reasoningEffort]: localizeEffortLabel(choice),
    });
  }
  const key = POWER_EFFORT_TRANSLATION_KEYS[choice.reasoningEffort];
  return composerCodexPowerChoiceLabel(choice, key ? { [choice.reasoningEffort]: t(key) } : {});
}

export const ComposerCodexPowerPicker = memo(function ComposerCodexPowerPicker(
  props: ComposerCodexPowerPickerProps,
) {
  const { t, format } = useTranslation();
  const {
    choices,
    selectedIndex,
    fallbackIndex,
    fastModeEnabled,
    fastModeAvailable = true,
    advancedContent,
    onPowerChange,
    onFastModeChange,
    onAdvancedToggle,
    onReset,
    onRequestClose,
    onFocusTrigger,
    disabled = false,
    hideViewControls = false,
    localizeEffortLabel,
  } = props;
  const [view, setView] = useState<"compact" | "advanced">(() =>
    selectedIndex === null ? "advanced" : "compact",
  );
  const [localIndex, setLocalIndex] = useState(() =>
    clampIndex(selectedIndex ?? fallbackIndex ?? 0, choices.length),
  );
  const [showEndpointLabels, setShowEndpointLabels] = useState(false);
  const [showUltraWarning, setShowUltraWarning] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [heights, setHeights] = useState<MeasuredHeights>(INITIAL_HEIGHTS);
  const [transitionsReady, setTransitionsReady] = useState(false);
  const reducedMotion = useReducedMotion() ?? false;
  const heightsRef = useRef(INITIAL_HEIGHTS);
  const heightFrameRef = useRef<number | null>(null);
  const liveStatusId = useId();
  const fastDescriptionId = useId();
  const compactPanelRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const advancedPanelRef = useRef<HTMLDivElement>(null);
  const keyboardItemRef = useRef<HTMLDivElement>(null);
  const localIndexRef = useRef(localIndex);
  const ultraWarningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isCompactVisible = choices.length >= COMPOSER_POWER_MIN_CHOICES && view === "compact";
  const visibleIndex = clampIndex(localIndex, choices.length);
  const selectedChoice = choices[visibleIndex];
  const fallbackChoice = fallbackIndex === null ? null : choices[fallbackIndex];
  const selectedChoiceLabel = selectedChoice
    ? localizedChoiceLabel(selectedChoice, t, localizeEffortLabel)
    : t("chat.codexPower.noChoice");
  const menuHeight = heights.controls + (view === "compact" ? heights.compact : heights.advanced);
  const trackOffset = view === "compact" ? 0 : -heights.compact;
  const topTrackOffset = view === "compact" ? -heights.advanced : 0;
  const sliderOptions = useMemo<ComposerCodexPowerSliderOption[]>(
    () =>
      choices.map((choice) => ({
        id: `${choice.model}\u0000${choice.reasoningEffort}`,
        isMax: choice.isUltra,
      })),
    [choices],
  );

  const updateLocalIndex = useCallback(
    (nextIndex: number) => {
      const next = clampIndex(nextIndex, choices.length);
      localIndexRef.current = next;
      setLocalIndex((current) => (current === next ? current : next));
      return choices[next];
    },
    [choices],
  );

  const hideUltraWarning = useCallback(() => {
    if (ultraWarningTimerRef.current !== null) {
      clearTimeout(ultraWarningTimerRef.current);
      ultraWarningTimerRef.current = null;
    }
    setShowUltraWarning(false);
  }, []);

  const announceUltraWarning = useCallback(() => {
    if (ultraWarningTimerRef.current !== null) {
      clearTimeout(ultraWarningTimerRef.current);
    }
    setShowUltraWarning(true);
    ultraWarningTimerRef.current = setTimeout(() => {
      ultraWarningTimerRef.current = null;
      setShowUltraWarning(false);
    }, POWER_ULTRA_WARNING_MS);
  }, []);

  const commitIndex = useCallback(
    (nextIndex: number, reason: ComposerCodexPowerSliderChangeReason | "keyboard") => {
      const previousChoice = choices[localIndexRef.current];
      const choice = updateLocalIndex(nextIndex);
      if (!choice || choice === previousChoice || disabled) return;
      // Leaving Ultra by any means dismisses the usage warning right away; the slider
      // itself asks for the warning only when a drag lands on Ultra.
      if (!choice.isUltra) hideUltraWarning();
      void onPowerChange(choice);
      if (reason === "keyboard") {
        window.requestAnimationFrame(() => keyboardItemRef.current?.focus());
      }
    },
    [choices, disabled, hideUltraWarning, onPowerChange, updateLocalIndex],
  );

  const completeKeyboardSelection = useCallback(() => {
    onRequestClose?.();
    window.requestAnimationFrame(() => {
      onFocusTrigger?.();
    });
  }, [onFocusTrigger, onRequestClose]);

  const toggleAdvancedView = useCallback(() => {
    setView((current) => (current === "compact" ? "advanced" : "compact"));
    onAdvancedToggle?.();
  }, [onAdvancedToggle]);

  const handleKeyboardItemKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (disabled) return;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        commitIndex(localIndexRef.current + 1, "keyboard");
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        commitIndex(localIndexRef.current - 1, "keyboard");
      } else if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        completeKeyboardSelection();
      }
    },
    [commitIndex, completeKeyboardSelection, disabled],
  );

  const handleSliderSelect = useCallback(
    (index: number, reason: ComposerCodexPowerSliderChangeReason) => {
      commitIndex(index, reason);
    },
    [commitIndex],
  );

  useEffect(() => {
    localIndexRef.current = clampIndex(selectedIndex ?? localIndexRef.current, choices.length);
    if (selectedIndex !== null) {
      setLocalIndex(selectedIndex);
    } else {
      setView("advanced");
    }
  }, [choices.length, selectedIndex]);

  useEffect(() => {
    let frame = window.requestAnimationFrame(() => setTransitionsReady(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const nodes = [compactPanelRef.current, controlsRef.current, advancedPanelRef.current].filter(
      (node): node is HTMLDivElement => node !== null,
    );
    if (nodes.length === 0 || typeof ResizeObserver === "undefined") return;
    const publishHeights = () => {
      if (heightFrameRef.current !== null) return;
      heightFrameRef.current = window.requestAnimationFrame(() => {
        heightFrameRef.current = null;
        const latest = heightsRef.current;
        setHeights((previous) => (isHeightChange(previous, latest) ? latest : previous));
      });
    };
    const observer = new ResizeObserver((entries) => {
      const next = { ...heightsRef.current };
      for (const entry of entries) {
        const target = entry.target;
        const borderBox = Array.isArray(entry.borderBoxSize)
          ? entry.borderBoxSize[0]
          : entry.borderBoxSize;
        const fallbackHeight =
          target instanceof HTMLElement ? target.offsetHeight : entry.contentRect.height;
        const height = Math.round(borderBox?.blockSize ?? fallbackHeight);
        if (target === compactPanelRef.current) next.compact = height;
        if (target === controlsRef.current) next.controls = height;
        if (target === advancedPanelRef.current) next.advanced = height;
      }
      if (!isHeightChange(heightsRef.current, next)) return;
      heightsRef.current = next;
      publishHeights();
    });
    for (const node of nodes) observer.observe(node);
    return () => {
      observer.disconnect();
      if (heightFrameRef.current !== null) {
        window.cancelAnimationFrame(heightFrameRef.current);
        heightFrameRef.current = null;
      }
    };
  }, [hideViewControls]);

  useEffect(() => {
    return () => {
      if (ultraWarningTimerRef.current !== null) clearTimeout(ultraWarningTimerRef.current);
    };
  }, []);

  const handleReset = useCallback(() => {
    if (!fallbackChoice || disabled) return;
    updateLocalIndex(fallbackIndex ?? 0);
    setView("compact");
    void (onReset ? onReset(fallbackChoice) : onPowerChange(fallbackChoice));
  }, [disabled, fallbackChoice, fallbackIndex, onPowerChange, onReset, updateLocalIndex]);

  if (choices.length < COMPOSER_POWER_MIN_CHOICES) return <>{advancedContent}</>;

  const pickerStyle = {
    ...(menuHeight > 0 ? { "--composer-codex-power-menu-height": `${menuHeight}px` } : {}),
    "--composer-codex-power-track-offset": `${trackOffset}px`,
    "--composer-codex-power-track-offset-top": `${topTrackOffset}px`,
  } as CSSProperties;
  const compactHidden = !isCompactVisible;
  const advancedHidden = isCompactVisible;
  const compactActionLabel =
    selectedIndex === null ? t("chat.codexPower.reset") : t("chat.codexPower.advanced");
  const liveStatus =
    format("chat.codexPower.status", {
      choice: selectedChoiceLabel,
      position: visibleIndex + 1,
      total: choices.length,
    }) + (selectedChoice?.isUltra ? ` ${t("chat.codexPower.ultraWarning")}` : "");
  const fastModeItem = (
    <MenuCheckboxItem
      aria-describedby={fastDescriptionId}
      aria-label={
        fastModeEnabled
          ? t("chat.codexPower.enableStandardMode")
          : t("chat.codexPower.enableFastMode")
      }
      checked={fastModeEnabled}
      className="composer-codex-power__fast-item"
      closeOnClick={false}
      data-fast-mode-enabled={fastModeEnabled ? "true" : "false"}
      data-codex-power-fast-item="true"
      data-max-power-selection={selectedChoice?.isUltra ? "true" : "false"}
      disabled={disabled}
      onCheckedChange={(checked) => onFastModeChange(checked)}
    >
      <span className="composer-codex-power__fast-copy">
        {fastModeEnabled ? (
          <FastModeIcon aria-hidden="true" className="composer-codex-power__bolt" />
        ) : (
          <FastModeOutlineIcon aria-hidden="true" className="composer-codex-power__bolt" />
        )}
        <span className="sr-only">
          {fastModeEnabled ? t("chat.codexPower.fast") : t("chat.codexPower.default")}
        </span>
        <span className="composer-codex-power__fast-detail sr-only" id={fastDescriptionId}>
          {t("chat.codexPower.moreUsage")}
        </span>
      </span>
    </MenuCheckboxItem>
  );
  const toggleVisible = !showUltraWarning && !showEndpointLabels;
  const fastVisible = isCompactVisible && toggleVisible && selectedIndex !== null;
  const endpointsVisible = isCompactVisible && showEndpointLabels && !showUltraWarning;
  const warningVisible = isCompactVisible && showUltraWarning;
  const controlsState = selectedIndex === null ? "advanced-reset" : view;
  const viewControls = hideViewControls ? null : (
    <div
      ref={controlsRef}
      className="composer-codex-power__header"
      data-codex-power-controls-state={controlsState}
      data-codex-power-header-controls="true"
      data-expanded={view === "advanced" ? "true" : "false"}
      data-ultra-warning-visible={warningVisible ? "true" : "false"}
    >
      <div
        aria-hidden={!toggleVisible}
        className="composer-codex-power__control composer-codex-power__control--toggle"
        data-codex-power-toggle="true"
        data-expanded={toggleVisible ? "true" : "false"}
        inert={toggleVisible ? undefined : true}
      >
        <MenuItem
          aria-label={
            view === "advanced"
              ? selectedIndex === null
                ? t("chat.codexPower.reset")
                : t("chat.codexPower.showCompact")
              : t("chat.codexPower.showAdvanced")
          }
          className={cn(
            "composer-codex-power__header-action",
            selectedIndex === null && "composer-codex-power__reset-action",
          )}
          closeOnClick={false}
          disabled={disabled}
          onClick={selectedIndex === null ? handleReset : toggleAdvancedView}
          tabIndex={toggleVisible ? undefined : -1}
        >
          {selectedIndex === null ? (
            <>
              <RotateCcwIcon aria-hidden="true" className="composer-codex-power__reset-icon" />
              {compactActionLabel}
            </>
          ) : (
            <span className="composer-codex-power__header-action-content">
              {compactActionLabel}
              <ChevronRightIcon
                aria-hidden="true"
                className="composer-codex-power__advanced-chevron"
                data-codex-power-chevron="true"
              />
            </span>
          )}
        </MenuItem>
      </div>

      {fastModeAvailable ? (
        <div
          aria-hidden={!fastVisible}
          className="composer-codex-power__control composer-codex-power__control--fast"
          data-codex-power-fast-control="true"
          data-expanded={fastVisible ? "true" : "false"}
          inert={fastVisible ? undefined : true}
        >
          <div className="composer-codex-power__fast-item-wrap">
            <Tooltip>
              <TooltipTrigger
                render={cloneElement(fastModeItem, { tabIndex: fastVisible ? undefined : -1 })}
              />
              <TooltipPopup side="top" variant="picker">
                <span className="flex flex-col px-1 py-0.5">
                  <span>{t("chat.codexPower.fastSpeed")}</span>
                  <span>{t("chat.codexPower.moreUsage")}</span>
                </span>
              </TooltipPopup>
            </Tooltip>
          </div>
        </div>
      ) : null}

      <div
        aria-hidden={!endpointsVisible}
        className="composer-codex-power__control composer-codex-power__control--endpoints"
        data-codex-power-endpoints="true"
        data-expanded={endpointsVisible ? "true" : "false"}
        inert={endpointsVisible ? undefined : true}
      >
        <span className="composer-codex-power__endpoint composer-codex-power__endpoint--left">
          {t("chat.codexPower.faster")}
        </span>
        <span className="composer-codex-power__endpoint composer-codex-power__endpoint--right">
          {t("chat.codexPower.smarter")}
        </span>
      </div>

      <div
        aria-hidden={!warningVisible}
        className="composer-codex-power__control composer-codex-power__control--warning"
        data-codex-power-warning-control="true"
        data-expanded={warningVisible ? "true" : "false"}
        inert={warningVisible ? undefined : true}
      >
        <span
          className="composer-codex-power__warning composer-codex-power__warning--row"
          data-codex-power-ultra-warning="true"
        >
          <span className="composer-codex-power__warning-text">
            {t("chat.codexPower.ultraWarning")}
          </span>
        </span>
      </div>
    </div>
  );

  return (
    <div
      className={cn("composer-codex-power", transitionsReady && "composer-codex-power--ready")}
      data-codex-power-picker="true"
      data-codex-power-dragging={isDragging ? "true" : undefined}
      data-codex-power-endpoints-visible={endpointsVisible ? "true" : "false"}
      data-codex-power-view={view}
      data-reduced-motion={reducedMotion ? "true" : "false"}
      style={{
        ...pickerStyle,
        ...(menuHeight > 0 ? { height: `${menuHeight}px` } : {}),
      }}
    >
      <div className="composer-codex-power__viewport" data-codex-power-viewport="true">
        <div className="composer-codex-power__panel-track" data-codex-power-panel-track="true">
          <div
            ref={compactPanelRef}
            aria-hidden={compactHidden}
            className={cn(
              "composer-codex-power__panel",
              "composer-codex-power__panel--compact",
              compactHidden && "composer-codex-power__panel--inactive",
            )}
            data-codex-power-panel="compact"
            inert={compactHidden ? true : undefined}
          >
            <MenuItem
              ref={keyboardItemRef}
              aria-label={t("chat.codexPower.accessibleName")}
              aria-describedby={liveStatusId}
              className="composer-codex-power__keyboard-item sr-only"
              data-codex-power-keyboard-item="true"
              closeOnClick={false}
              disabled={disabled}
              label={t("chat.codexPower.accessibleName")}
              onKeyDown={handleKeyboardItemKeyDown}
            />

            <div className="composer-codex-power__slider-row" data-codex-power-slider-frame="true">
              <ComposerCodexPowerSlider
                active={isCompactVisible}
                disabled={disabled}
                fastModeEnabled={fastModeEnabled}
                onDragToMax={announceUltraWarning}
                onDraggingChange={setIsDragging}
                onEndpointLabelsVisibleChange={setShowEndpointLabels}
                onSelectIndex={handleSliderSelect}
                options={sliderOptions}
                reducedMotion={reducedMotion}
                selectedIndex={visibleIndex}
                transitionsReady={transitionsReady}
              />
            </div>

            <span
              id={liveStatusId}
              aria-live="polite"
              className="composer-codex-power__live-status sr-only"
              data-codex-power-live-status="true"
            >
              {liveStatus}
            </span>
          </div>

          {viewControls}

          <div
            ref={advancedPanelRef}
            aria-hidden={advancedHidden}
            className={cn(
              "composer-codex-power__panel",
              "composer-codex-power__panel--advanced",
              advancedHidden && "composer-codex-power__panel--inactive",
            )}
            data-codex-power-panel="advanced"
            inert={advancedHidden ? true : undefined}
          >
            {advancedContent}
          </div>
        </div>
      </div>
    </div>
  );
});
