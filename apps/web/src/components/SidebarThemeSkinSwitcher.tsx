import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { CentralIcon } from "~/lib/central-icons";
import randomizeSvg from "../assets/theme-randomize.svg?raw";
import { useTheme } from "../hooks/useTheme";
import {
  DEFAULT_THEME_SKIN,
  HEAVY_ANCHORS,
  PATTERNS,
  PRESETS,
  clamp,
  getGradientStops,
  interpolateColor,
  nextThemeSkinPattern,
  normalizeHue,
  normalizeThemeSkin,
  oklchCss,
  patternBackground,
  polarToPoint,
  scaledChroma,
  themeSkinPatternLayerOpacity,
  themeSkinToAppSurfaceCssVariables,
  themeSkinToChromeThemePatch,
  type ThemeSkinState,
} from "../theme/themeSkin.logic";

const PANEL_WIDTH = 324;
const PANEL_GAP = 16;
const PANEL_MIN_BOTTOM = 24;
const PANEL_VIEWPORT_MARGIN = 16;
const STORAGE_KEY = "moss:theme-skin";
const DEFAULT_WHITE_PRESET_NAME = "default-white";
const DRAGGING_CLASS_NAME = "moss-theme-skin-dragging";
const PANEL_EXIT_DURATION_MS = 150;
const LEGACY_SKIN_SURFACE_VARIABLES = ["--app-chat-background-surface"] as const;

type DragMode = "wheel" | "saturation" | "patternOpacity";
type SkinUpdater = ThemeSkinState | ((current: ThemeSkinState) => ThemeSkinState);

interface PendingLiveSkin {
  mode: DragMode;
  skin: ThemeSkinState;
}

interface InlineStyleSnapshot {
  name: string;
  node: HTMLElement;
  priority: string;
  value: string;
}

interface LiveSurfaceTargets {
  backgroundNodes: HTMLElement[];
  createdNodes: HTMLElement[];
  patternVariableNodes: HTMLElement[];
  snapshots: InlineStyleSnapshot[];
}

interface StoredThemeSkinSnapshot {
  skin: ThemeSkinState;
  stored: boolean;
}

export function SidebarThemeSkinSwitcher() {
  const { resetThemeVariant, resolvedTheme, themeState } = useTheme();
  const initialSnapshotRef = useRef<StoredThemeSkinSnapshot | null>(null);
  const [skin, setSkin] = useState(() => {
    const snapshot = readStoredThemeSkinSnapshot();
    initialSnapshotRef.current = snapshot;
    return snapshot.skin;
  });
  const skinRef = useRef(skin);
  const [hasUserSkin, setHasUserSkin] = useState(() => initialSnapshotRef.current?.stored ?? false);
  const [open, setOpen] = useState(false);
  const [panelMounted, setPanelMounted] = useState(false);
  const [wheelSize, setWheelSize] = useState(306);
  const [panelStyle, setPanelStyle] = useState({ bottom: 24, left: 274 });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const colorSpaceRef = useRef<HTMLDivElement | null>(null);
  const primaryHandleRef = useRef<HTMLDivElement | null>(null);
  const gradientLeftHandleRef = useRef<HTMLDivElement | null>(null);
  const gradientRightHandleRef = useRef<HTMLDivElement | null>(null);
  const saturationFillRef = useRef<HTMLSpanElement | null>(null);
  const patternHandleRef = useRef<HTMLDivElement | null>(null);
  const randomizeIconRef = useRef<HTMLSpanElement | null>(null);
  const draggingRef = useRef<DragMode | null>(null);
  const dragPointerIdRef = useRef<number | null>(null);
  const dragRectRef = useRef<DOMRectReadOnly | null>(null);
  const liveFrameRef = useRef<number | null>(null);
  const pendingLiveSkinRef = useRef<PendingLiveSkin | null>(null);
  const liveSurfaceTargetsRef = useRef<LiveSurfaceTargets | null>(null);
  const panelCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelPositionFrameRef = useRef<number | null>(null);
  const appliedSkinVariablesRef = useRef<Record<string, string>>({});
  const skinSurfaceActivatedRef = useRef(false);

  const applySkinSurfaceVariables = useCallback(
    (nextSkin: ThemeSkinState, liveMode?: DragMode) => {
      const root = document.documentElement;
      if (!skinSurfaceActivatedRef.current) {
        root.setAttribute("data-theme-skin-active", "true");
        for (const name of LEGACY_SKIN_SURFACE_VARIABLES) {
          root.style.removeProperty(name);
        }
        skinSurfaceActivatedRef.current = true;
      }

      const setVariable = (name: string, value: string) => {
        if (appliedSkinVariablesRef.current[name] === value) {
          return;
        }
        appliedSkinVariablesRef.current[name] = value;
        root.style.setProperty(name, value);
      };

      if (liveMode !== "patternOpacity") {
        const variables = themeSkinToAppSurfaceCssVariables(nextSkin, resolvedTheme);
        for (const [name, value] of Object.entries(variables)) {
          setVariable(name, value);
        }
      }

      if (liveMode === undefined) {
        setVariable("--moss-theme-skin-pattern-image", patternBackground(nextSkin.pattern));
      }
      if (liveMode === undefined || liveMode === "patternOpacity") {
        setVariable(
          "--moss-theme-skin-pattern-opacity",
          String(themeSkinPatternLayerOpacity(nextSkin.pattern, nextSkin.patternOpacity)),
        );
      }
    },
    [resolvedTheme],
  );

  const clearSkinThemePackOverrides = useCallback(
    (nextSkin: ThemeSkinState) => {
      for (const variant of ["light", "dark"] as const) {
        const currentTheme = themeState.chromeThemes[variant];
        const skinPatch = themeSkinToChromeThemePatch(nextSkin, variant);
        const wasAppliedAsThemePack =
          currentTheme.accent === skinPatch.accent &&
          currentTheme.contrast === skinPatch.contrast &&
          currentTheme.ink === skinPatch.ink &&
          currentTheme.surface === skinPatch.surface;
        if (wasAppliedAsThemePack) {
          resetThemeVariant(variant);
        }
      }
    },
    [resetThemeVariant, themeState.chromeThemes],
  );

  const applyLiveEditorSkin = useCallback(
    (nextSkin: ThemeSkinState, mode: DragMode) => {
      const liveTargets = liveSurfaceTargetsRef.current;

      if (mode === "patternOpacity") {
        const patternOpacity = String(
          themeSkinPatternLayerOpacity(nextSkin.pattern, nextSkin.patternOpacity),
        );
        for (const node of liveTargets?.patternVariableNodes ?? []) {
          node.style.setProperty("--moss-theme-skin-pattern-opacity", patternOpacity);
        }
        const trackWidth = Math.max(1, (dragRectRef.current?.width ?? 308) - 32);
        patternHandleRef.current?.style.setProperty(
          "--moss-theme-skin-slider-offset",
          `${(trackWidth * nextSkin.patternOpacity) / 100}px`,
        );
        return;
      }

      const surface = themeSkinToAppSurfaceCssVariables(nextSkin, resolvedTheme)[
        "--moss-theme-skin-sidebar-surface"
      ];
      if (surface) {
        for (const node of liveTargets?.backgroundNodes ?? []) {
          node.style.setProperty("background-color", surface);
        }
      }

      const primaryColor = oklchCss({
        c: scaledChroma(nextSkin.c, nextSkin.saturation),
        h: normalizeHue(nextSkin.h),
        l: nextSkin.l,
      });
      if (primaryHandleRef.current) {
        primaryHandleRef.current.style.backgroundColor = primaryColor;
      }

      if (nextSkin.isGradient) {
        const gradientStops = getGradientStops(nextSkin);
        if (gradientLeftHandleRef.current) {
          gradientLeftHandleRef.current.style.backgroundColor = oklchCss(
            gradientStops[0] ?? nextSkin,
            nextSkin.opacity / 100,
          );
        }
        if (gradientRightHandleRef.current) {
          gradientRightHandleRef.current.style.backgroundColor = oklchCss(
            gradientStops[2] ?? nextSkin,
            nextSkin.opacity / 100,
          );
        }
      }

      if (mode === "saturation") {
        saturationFillRef.current?.style.setProperty(
          "transform",
          `scaleY(${nextSkin.saturation / 100})`,
        );
        return;
      }

      const size = dragRectRef.current?.width ?? (wheelSize || 306);
      const center = size / 2;
      const angle = normalizeHue(nextSkin.h);
      const radius = nextSkin.isGradient ? 140 : 116;
      const position = polarToPoint(angle, radius, center, center);
      const colorSpace = colorSpaceRef.current;
      if (colorSpace) {
        const maskPosition = `${position.x - radius}px ${position.y - radius}px`;
        colorSpace.style.maskPosition = maskPosition;
        colorSpace.style.webkitMaskPosition = maskPosition;
      }
      if (primaryHandleRef.current) {
        primaryHandleRef.current.style.transform = `translate3d(${position.x}px, ${position.y}px, 0) translate(-50%, -50%)`;
      }
      if (nextSkin.isGradient) {
        const left = polarToPoint(angle - 25, 140, center, center);
        const right = polarToPoint(angle + 25, 140, center, center);
        if (gradientLeftHandleRef.current) {
          gradientLeftHandleRef.current.style.transform = `translate3d(${left.x}px, ${left.y}px, 0) translate(-50%, -50%)`;
        }
        if (gradientRightHandleRef.current) {
          gradientRightHandleRef.current.style.transform = `translate3d(${right.x}px, ${right.y}px, 0) translate(-50%, -50%)`;
        }
      }
    },
    [resolvedTheme, wheelSize],
  );

  const flushLiveSkin = useCallback(() => {
    liveFrameRef.current = null;
    const pending = pendingLiveSkinRef.current;
    pendingLiveSkinRef.current = null;
    if (pending) {
      applyLiveEditorSkin(pending.skin, pending.mode);
    }
  }, [applyLiveEditorSkin]);

  const flushLiveSkinNow = useCallback(() => {
    if (liveFrameRef.current !== null) {
      cancelAnimationFrame(liveFrameRef.current);
      liveFrameRef.current = null;
    }
    flushLiveSkin();
  }, [flushLiveSkin]);

  const queueLiveSkin = useCallback(
    (mode: DragMode, updater: (current: ThemeSkinState) => ThemeSkinState) => {
      const nextSkin = normalizeThemeSkin(updater(skinRef.current));
      skinRef.current = nextSkin;
      pendingLiveSkinRef.current = { mode, skin: nextSkin };
      if (liveFrameRef.current === null) {
        liveFrameRef.current = requestAnimationFrame(flushLiveSkin);
      }
    },
    [flushLiveSkin],
  );

  const commitSkin = useCallback(
    (updater: SkinUpdater) => {
      const nextSkin = normalizeThemeSkin(
        typeof updater === "function" ? updater(skinRef.current) : updater,
      );
      skinRef.current = nextSkin;
      setSkin(nextSkin);
      setHasUserSkin(true);
      writeStoredThemeSkin(nextSkin);
      clearSkinThemePackOverrides(nextSkin);
      applySkinSurfaceVariables(nextSkin);
    },
    [applySkinSurfaceVariables, clearSkinThemePackOverrides],
  );

  useEffect(() => {
    if (initialSnapshotRef.current?.stored) {
      clearSkinThemePackOverrides(skinRef.current);
      applySkinSurfaceVariables(skinRef.current);
    }
  }, [applySkinSurfaceVariables, clearSkinThemePackOverrides]);

  useEffect(() => {
    if (!hasUserSkin) {
      return undefined;
    }
    applySkinSurfaceVariables(skinRef.current);
    return undefined;
  }, [applySkinSurfaceVariables, hasUserSkin, themeState]);

  useEffect(
    () => () => {
      if (liveFrameRef.current !== null) {
        cancelAnimationFrame(liveFrameRef.current);
      }
      if (panelPositionFrameRef.current !== null) {
        cancelAnimationFrame(panelPositionFrameRef.current);
      }
      if (panelCloseTimerRef.current !== null) {
        clearTimeout(panelCloseTimerRef.current);
      }
      pendingLiveSkinRef.current = null;
      draggingRef.current = null;
      dragPointerIdRef.current = null;
      dragRectRef.current = null;
      restoreLiveSurfaceTargets(liveSurfaceTargetsRef.current);
      liveSurfaceTargetsRef.current = null;
      document.body.classList.remove(DRAGGING_CLASS_NAME);
      delete document.body.dataset.mossThemeSkinDrag;
    },
    [],
  );

  const openPanel = useCallback(() => {
    if (panelCloseTimerRef.current !== null) {
      clearTimeout(panelCloseTimerRef.current);
      panelCloseTimerRef.current = null;
    }
    setPanelMounted(true);
    setOpen(true);
  }, []);

  const closePanel = useCallback(() => {
    setOpen(false);
    if (prefersReducedMotion()) {
      setPanelMounted(false);
      return;
    }
    if (panelCloseTimerRef.current !== null) {
      clearTimeout(panelCloseTimerRef.current);
    }
    panelCloseTimerRef.current = setTimeout(() => {
      panelCloseTimerRef.current = null;
      setPanelMounted(false);
    }, PANEL_EXIT_DURATION_MS + 34);
  }, []);

  const measurePanelPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const left = Math.max(
      PANEL_VIEWPORT_MARGIN,
      Math.min(
        window.innerWidth - PANEL_WIDTH - PANEL_VIEWPORT_MARGIN,
        Math.round(rect.right + PANEL_GAP),
      ),
    );
    const bottom = Math.max(
      PANEL_MIN_BOTTOM,
      Math.round(window.innerHeight - rect.bottom - PANEL_GAP),
    );
    setPanelStyle((current) =>
      current.bottom === bottom && current.left === left ? current : { bottom, left },
    );
  }, []);

  const schedulePanelPosition = useCallback(() => {
    if (panelPositionFrameRef.current !== null) {
      return;
    }
    panelPositionFrameRef.current = requestAnimationFrame(() => {
      panelPositionFrameRef.current = null;
      measurePanelPosition();
    });
  }, [measurePanelPosition]);

  useLayoutEffect(() => {
    if (!open) {
      return undefined;
    }

    measurePanelPosition();
    window.addEventListener("resize", schedulePanelPosition);
    window.addEventListener("scroll", schedulePanelPosition, true);

    return () => {
      window.removeEventListener("resize", schedulePanelPosition);
      window.removeEventListener("scroll", schedulePanelPosition, true);
      if (panelPositionFrameRef.current !== null) {
        cancelAnimationFrame(panelPositionFrameRef.current);
        panelPositionFrameRef.current = null;
      }
    };
  }, [measurePanelPosition, open, schedulePanelPosition]);

  useLayoutEffect(() => {
    if (!open) {
      return undefined;
    }

    const node = colorSpaceRef.current;
    if (!node) {
      return undefined;
    }

    const updateSize = (width: number) => {
      if (width > 0) {
        setWheelSize((current) => (Math.abs(current - width) < 0.01 ? current : width));
      }
    };

    updateSize(node.getBoundingClientRect().width);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(([entry]) => {
            if (entry) {
              updateSize(entry.contentRect.width);
            }
          });
    observer?.observe(node);

    return () => {
      observer?.disconnect();
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) {
        return;
      }
      closePanel();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closePanel();
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closePanel, open]);

  const resetRandomizeIcon = useCallback(() => {
    const svg = randomizeIconRef.current?.querySelector("svg");
    svg?.pauseAnimations?.();
    svg?.setCurrentTime?.(0.0001);
  }, []);

  const playRandomizeIcon = useCallback(() => {
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (reduceMotion) {
      return;
    }
    randomizeIconRef.current?.querySelector("svg")?.unpauseAnimations?.();
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      return undefined;
    }
    resetRandomizeIcon();
    return undefined;
  }, [open, resetRandomizeIcon]);

  const geometry = useMemo(() => {
    const angle = normalizeHue(skin.h);
    const size = wheelSize || 306;
    const center = size / 2;
    const radius = skin.isGradient ? 140 : 116;
    const position = polarToPoint(angle, radius, center, center);
    const left = polarToPoint(angle - 25, 140, center, center);
    const right = polarToPoint(angle + 25, 140, center, center);
    const gradientStops = getGradientStops(skin);
    return { angle, center, gradientStops, left, position, radius, right };
  }, [skin, wheelSize]);

  const currentPresetIndex = useMemo(
    () =>
      PRESETS.findIndex((preset) => {
        const isGradient = preset.colors.length > 1;
        const main = preset.colors[isGradient ? 1 : 0] ?? preset.colors[0];
        if (!main) {
          return false;
        }
        return (
          isGradient === skin.isGradient &&
          Math.abs(normalizeHue(main.h) - geometry.angle) < 0.75 &&
          Math.abs(main.l - skin.l) < 0.01 &&
          Math.abs(main.c - skin.c) < 0.01
        );
      }),
    [geometry.angle, skin.c, skin.isGradient, skin.l],
  );

  const beginDrag = useCallback((mode: DragMode, pointerId: number, rect: DOMRectReadOnly) => {
    if (draggingRef.current !== null) {
      return false;
    }
    draggingRef.current = mode;
    dragPointerIdRef.current = pointerId;
    dragRectRef.current = rect;
    liveSurfaceTargetsRef.current = collectLiveSurfaceTargets();
    document.body.classList.add(DRAGGING_CLASS_NAME);
    document.body.dataset.mossThemeSkinDrag = mode;
    return true;
  }, []);

  const endDrag = useCallback(
    (pointerId?: number) => {
      if (draggingRef.current === null) {
        return;
      }
      if (pointerId !== undefined && dragPointerIdRef.current !== pointerId) {
        return;
      }
      flushLiveSkinNow();
      const nextSkin = skinRef.current;
      draggingRef.current = null;
      dragPointerIdRef.current = null;
      dragRectRef.current = null;
      setSkin(nextSkin);
      setHasUserSkin(true);
      writeStoredThemeSkin(nextSkin);
      clearSkinThemePackOverrides(nextSkin);
      applySkinSurfaceVariables(nextSkin);
      restoreLiveSurfaceTargets(liveSurfaceTargetsRef.current);
      liveSurfaceTargetsRef.current = null;
      document.body.classList.remove(DRAGGING_CLASS_NAME);
      delete document.body.dataset.mossThemeSkinDrag;
    },
    [applySkinSurfaceVariables, clearSkinThemePackOverrides, flushLiveSkinNow],
  );

  useEffect(() => {
    if (!open) {
      endDrag();
    }
  }, [endDrag, open]);

  const updateFromWheelPointer = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (dragPointerIdRef.current !== event.pointerId) {
        return;
      }
      const node = colorSpaceRef.current;
      if (!node) {
        return;
      }
      const rect = dragRectRef.current ?? node.getBoundingClientRect();
      const point = latestPointerPoint(event);
      const x = clamp(point.clientX - rect.left, 0, rect.width);
      const y = clamp(point.clientY - rect.top, 0, rect.height);
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const degrees = normalizeHue((Math.atan2(y - cy, x - cx) * 180) / Math.PI);
      const base = interpolateColor(degrees, HEAVY_ANCHORS);
      queueLiveSkin("wheel", (current) => ({
        ...current,
        c: base.c,
        h: degrees,
        l: base.l,
      }));
    },
    [queueLiveSkin],
  );

  const updateSaturationFromPointer = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (dragPointerIdRef.current !== event.pointerId) {
        return;
      }
      const node = colorSpaceRef.current;
      if (!node) {
        return;
      }
      const rect = dragRectRef.current ?? node.getBoundingClientRect();
      const point = latestPointerPoint(event);
      const localY = clamp(point.clientY - rect.top, 0, rect.height);
      queueLiveSkin("saturation", (current) => ({
        ...current,
        saturation: Math.round((1 - localY / rect.height) * 100),
      }));
    },
    [queueLiveSkin],
  );

  const updateSliderFromPointer = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, key: "patternOpacity") => {
      if (dragPointerIdRef.current !== event.pointerId) {
        return;
      }
      const rect = dragRectRef.current ?? event.currentTarget.getBoundingClientRect();
      const point = latestPointerPoint(event);
      const value = Math.round(
        clamp((point.clientX - rect.left - 4) / Math.max(1, rect.width - 32), 0, 1) * 100,
      );
      queueLiveSkin("patternOpacity", (current) => ({ ...current, [key]: value }));
    },
    [queueLiveSkin],
  );

  const onSliderKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>, key: "patternOpacity") => {
      if (!["ArrowLeft", "ArrowDown", "ArrowRight", "ArrowUp", "Home", "End"].includes(event.key)) {
        return;
      }

      event.preventDefault();
      const delta = event.shiftKey ? 10 : 1;
      commitSkin((current) => {
        if (event.key === "Home") {
          return { ...current, [key]: 0 };
        }
        if (event.key === "End") {
          return { ...current, [key]: 100 };
        }
        const direction = event.key === "ArrowLeft" || event.key === "ArrowDown" ? -delta : delta;
        return { ...current, [key]: clamp(current[key] + direction, 0, 100) };
      });
    },
    [commitSkin],
  );

  const sliderHandleStyle = useCallback(
    (value: number): CSSProperties =>
      ({
        "--moss-theme-skin-slider-offset": `${(276 * value) / 100}px`,
      }) as CSSProperties,
    [],
  );

  const selectNextPattern = useCallback(() => {
    commitSkin((current) => ({
      ...current,
      pattern: nextThemeSkinPattern(current.pattern),
    }));
  }, [commitSkin]);

  const randomizeSkin = useCallback(() => {
    const indexedPresets = PRESETS.map((preset, index) => ({ index, preset })).filter(
      ({ preset }) => preset.name !== DEFAULT_WHITE_PRESET_NAME,
    );
    let pool = indexedPresets.filter(
      ({ index }) =>
        currentPresetIndex < 0 ||
        (index !== currentPresetIndex && Math.abs(index - currentPresetIndex) > 5),
    );
    if (pool.length === 0) {
      pool = indexedPresets.filter(({ index }) => index !== currentPresetIndex);
    }

    const choice =
      pool[Math.floor(Math.random() * pool.length)] ??
      indexedPresets[Math.floor(Math.random() * indexedPresets.length)];
    const preset = choice?.preset ?? PRESETS[0];
    if (!preset) {
      return;
    }
    const isGradient = preset.colors.length > 1;
    const main = preset.colors[isGradient ? 1 : 0] ?? preset.colors[0];
    if (!main) {
      return;
    }
    commitSkin((current) => ({
      ...current,
      c: main.c,
      h: main.h,
      isGradient,
      l: main.l,
      opacity: 80 + Math.floor(Math.random() * 21),
      pattern: PATTERNS[Math.floor(Math.random() * PATTERNS.length)] ?? "none",
      patternOpacity: 20 + Math.floor(Math.random() * 31),
      saturation: 70 + Math.floor(Math.random() * 31),
    }));
  }, [commitSkin, currentPresetIndex]);

  const panel = panelMounted ? (
    <div
      ref={panelRef}
      className={`moss-theme-skin-popover ${open ? "is-opening" : "is-closing"}`}
      role="dialog"
      aria-modal="true"
      aria-label="Theme editor"
      style={{ bottom: `${panelStyle.bottom}px`, left: `${panelStyle.left}px` }}
      onAnimationEnd={(event) => {
        if (event.target !== event.currentTarget || open) {
          return;
        }
        if (panelCloseTimerRef.current !== null) {
          clearTimeout(panelCloseTimerRef.current);
          panelCloseTimerRef.current = null;
        }
        setPanelMounted(false);
      }}
    >
      <div className="moss-theme-skin-editor">
        <div className="moss-theme-skin-content">
          <section className="moss-theme-skin-color-wheel-wrap">
            <div className="moss-theme-skin-wheel-surface">
              <div
                ref={colorSpaceRef}
                className={`moss-theme-skin-color-space${skin.isGradient ? " has-gradient" : ""}`}
                tabIndex={0}
                aria-label="Color wheel"
                style={{
                  WebkitMaskPosition: `${geometry.position.x - geometry.radius}px ${
                    geometry.position.y - geometry.radius
                  }px`,
                  maskPosition: `${geometry.position.x - geometry.radius}px ${
                    geometry.position.y - geometry.radius
                  }px`,
                  opacity: String((50 + 0.46 * skin.opacity) / 100),
                }}
                onPointerDown={(event) => {
                  if (!isPrimaryDragPointer(event)) {
                    return;
                  }
                  event.preventDefault();
                  if (
                    !beginDrag(
                      "wheel",
                      event.pointerId,
                      event.currentTarget.getBoundingClientRect(),
                    )
                  ) {
                    return;
                  }
                  event.currentTarget.setPointerCapture(event.pointerId);
                  updateFromWheelPointer(event);
                }}
                onPointerMove={(event) => {
                  if (draggingRef.current === "wheel") {
                    updateFromWheelPointer(event);
                  }
                }}
                onPointerUp={(event) => endDrag(event.pointerId)}
                onPointerCancel={(event) => endDrag(event.pointerId)}
                onLostPointerCapture={(event) => endDrag(event.pointerId)}
              >
                <div
                  ref={primaryHandleRef}
                  className="moss-theme-skin-wheel-handle primary"
                  style={{
                    backgroundColor: oklchCss({
                      c: scaledChroma(skin.c, skin.saturation),
                      h: geometry.angle,
                      l: skin.l,
                    }),
                    transform: `translate(${geometry.position.x}px, ${geometry.position.y}px) translate(-50%, -50%)`,
                  }}
                />
                <div
                  ref={gradientLeftHandleRef}
                  className="moss-theme-skin-wheel-handle gradient left"
                  style={{
                    backgroundColor: oklchCss(
                      geometry.gradientStops[0] ?? skin,
                      skin.opacity / 100,
                    ),
                    transform: `translate(${geometry.left.x}px, ${geometry.left.y}px) translate(-50%, -50%)`,
                  }}
                />
                <div
                  ref={gradientRightHandleRef}
                  className="moss-theme-skin-wheel-handle gradient right"
                  style={{
                    backgroundColor: oklchCss(
                      geometry.gradientStops[2] ?? skin,
                      skin.opacity / 100,
                    ),
                    transform: `translate(${geometry.right.x}px, ${geometry.right.y}px) translate(-50%, -50%)`,
                  }}
                />
              </div>
            </div>
            <div className="moss-theme-skin-wheel-options">
              <div className="moss-theme-skin-options-top">
                <button
                  className={`moss-theme-skin-round-control moss-theme-skin-gradient-toggle moss-theme-skin-shadow-small${
                    skin.isGradient ? " is-gradient" : ""
                  }`}
                  type="button"
                  aria-label="Toggle gradient mode"
                  data-tooltip={skin.isGradient ? "Apply solid" : "Apply gradient"}
                  onClick={() =>
                    commitSkin((current) => ({ ...current, isGradient: !current.isGradient }))
                  }
                >
                  <span className="moss-theme-skin-gradient-icon">
                    <span className="moss-theme-skin-gradient-icon-inner" />
                    <span className="moss-theme-skin-gradient-icon-dots" />
                  </span>
                </button>
                <button
                  className="moss-theme-skin-round-control moss-theme-skin-saturation-control moss-theme-skin-shadow-small"
                  type="button"
                  aria-label="Adjust saturation"
                  data-tooltip="Adjust saturation"
                  onPointerDown={(event) => {
                    if (!isPrimaryDragPointer(event)) {
                      return;
                    }
                    event.preventDefault();
                    const colorSpace = colorSpaceRef.current;
                    if (!colorSpace) {
                      return;
                    }
                    if (
                      !beginDrag("saturation", event.pointerId, colorSpace.getBoundingClientRect())
                    ) {
                      return;
                    }
                    event.currentTarget.setPointerCapture(event.pointerId);
                    updateSaturationFromPointer(event);
                  }}
                  onPointerMove={(event) => {
                    if (draggingRef.current === "saturation") {
                      updateSaturationFromPointer(event);
                    }
                  }}
                  onPointerUp={(event) => endDrag(event.pointerId)}
                  onPointerCancel={(event) => endDrag(event.pointerId)}
                  onLostPointerCapture={(event) => endDrag(event.pointerId)}
                >
                  <span className="moss-theme-skin-drop-base">
                    <span
                      ref={saturationFillRef}
                      className="moss-theme-skin-drop-fill"
                      style={{ transform: `scaleY(${skin.saturation / 100})` }}
                    />
                  </span>
                </button>
              </div>
              <div className="moss-theme-skin-options-bottom">
                <button
                  className="moss-theme-skin-round-control moss-theme-skin-surprise-control moss-theme-skin-shadow-small"
                  type="button"
                  aria-label="Randomize theme"
                  data-tooltip="Surprise me"
                  onBlur={resetRandomizeIcon}
                  onClick={randomizeSkin}
                  onFocus={playRandomizeIcon}
                  onMouseEnter={playRandomizeIcon}
                  onMouseLeave={resetRandomizeIcon}
                >
                  <span
                    ref={randomizeIconRef}
                    className="moss-theme-skin-randomize-icon"
                    aria-hidden="true"
                    dangerouslySetInnerHTML={{ __html: randomizeSvg }}
                  />
                </button>
              </div>
            </div>
          </section>

          <section className="moss-theme-skin-presets" aria-label="Theme presets">
            {PRESETS.map((preset, index) => {
              const selected = index === currentPresetIndex;
              const isDefaultWhite = preset.name === DEFAULT_WHITE_PRESET_NAME;
              return (
                <button
                  key={preset.name}
                  className={`moss-theme-skin-preset${selected ? " is-selected" : ""}${
                    isDefaultWhite ? " is-default-white" : ""
                  }`}
                  type="button"
                  aria-label={preset.name}
                  style={{
                    background: isDefaultWhite
                      ? undefined
                      : preset.colors.length > 1
                        ? `linear-gradient(135deg, ${preset.colors.map((color) => oklchCss(color)).join(", ")})`
                        : oklchCss(preset.colors[0] ?? DEFAULT_THEME_SKIN),
                  }}
                  onClick={() => {
                    if (isDefaultWhite) {
                      commitSkin(DEFAULT_THEME_SKIN);
                      return;
                    }
                    const isGradient = preset.colors.length > 1;
                    const next = preset.colors[isGradient ? 1 : 0] ?? preset.colors[0];
                    if (!next) {
                      return;
                    }
                    commitSkin((current) => ({
                      ...current,
                      c: next.c,
                      h: next.h,
                      isGradient,
                      l: next.l,
                      saturation: next.c < 0.001 ? 0 : 100,
                    }));
                  }}
                />
              );
            })}
          </section>

          <section className="moss-theme-skin-control-sliders" aria-label="Theme controls">
            <div
              className="moss-theme-skin-slider moss-theme-skin-pattern-slider"
              data-role="pattern"
              onPointerDown={(event) => {
                if (!isPrimaryDragPointer(event)) {
                  return;
                }
                event.preventDefault();
                if (
                  !beginDrag(
                    "patternOpacity",
                    event.pointerId,
                    event.currentTarget.getBoundingClientRect(),
                  )
                ) {
                  return;
                }
                event.currentTarget.setPointerCapture(event.pointerId);
                updateSliderFromPointer(event, "patternOpacity");
              }}
              onPointerMove={(event) => {
                if (draggingRef.current === "patternOpacity") {
                  updateSliderFromPointer(event, "patternOpacity");
                }
              }}
              onPointerUp={(event) => endDrag(event.pointerId)}
              onPointerCancel={(event) => endDrag(event.pointerId)}
              onLostPointerCapture={(event) => endDrag(event.pointerId)}
            >
              <div
                className="moss-theme-skin-pattern-preview"
                role="button"
                tabIndex={0}
                aria-label={`Select next texture. Current texture: ${skin.pattern}`}
                style={{ backgroundImage: patternBackground(skin.pattern) }}
                onClick={(event) => {
                  event.stopPropagation();
                  selectNextPattern();
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  selectNextPattern();
                }}
                onPointerDown={(event) => event.stopPropagation()}
              />
              <div
                ref={patternHandleRef}
                className="moss-theme-skin-slider-handle"
                role="slider"
                tabIndex={0}
                aria-label="Pattern opacity"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={skin.patternOpacity}
                style={sliderHandleStyle(skin.patternOpacity)}
                onKeyDown={(event) => onSliderKeyDown(event, "patternOpacity")}
              >
                <span />
                <span />
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="moss-theme-skin-trigger"
        aria-label="Edit theme skin"
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="sidebar-theme-skin-trigger"
        onClick={() => (open ? closePanel() : openPanel())}
      >
        <ThemeBrushIcon />
      </button>
      {typeof document === "undefined" ? null : createPortal(panel, document.body)}
    </>
  );
}

function collectLiveSurfaceTargets(): LiveSurfaceTargets {
  const sidebarSurfaces = uniqueElements([
    ...document.querySelectorAll<HTMLElement>(
      '[data-slot="sidebar"][data-side="left"] [data-slot="sidebar-inner"]',
    ),
    ...document.querySelectorAll<HTMLElement>(
      '[data-slot="sidebar"][data-mobile="true"][data-side="left"][data-sidebar="sidebar"]',
    ),
  ]);
  const persistentBackgroundNodes = uniqueElements([
    ...sidebarSurfaces,
    ...document.querySelectorAll<HTMLElement>(
      '[data-slot="sidebar"][data-side="left"] .sidebar-icon-chip',
    ),
    ...document.querySelectorAll<HTMLElement>(
      '[data-sidebar-side="left"] [data-slot="sidebar-inset"]:has(.chat-content-card)',
    ),
  ]);
  const createdNodes = [
    ...document.querySelectorAll<HTMLElement>(
      '[data-sidebar-side="left"] .chat-content-card-backing',
    ),
  ].map((backing) => {
    const seam = document.createElement("div");
    seam.className = "moss-theme-skin-live-seam";
    seam.setAttribute("aria-hidden", "true");
    seam.style.backgroundColor = getComputedStyle(backing, "::after").backgroundColor;
    backing.append(seam);
    return seam;
  });
  const backgroundNodes = [...persistentBackgroundNodes, ...createdNodes];
  const snapshots: InlineStyleSnapshot[] = [];
  for (const node of persistentBackgroundNodes) {
    snapshots.push(snapshotInlineProperty(node, "background-color"));
  }
  for (const node of sidebarSurfaces) {
    snapshots.push(snapshotInlineProperty(node, "--moss-theme-skin-pattern-opacity"));
  }
  return {
    backgroundNodes,
    createdNodes,
    patternVariableNodes: sidebarSurfaces,
    snapshots,
  };
}

function snapshotInlineProperty(node: HTMLElement, name: string): InlineStyleSnapshot {
  return {
    name,
    node,
    priority: node.style.getPropertyPriority(name),
    value: node.style.getPropertyValue(name),
  };
}

function restoreLiveSurfaceTargets(targets: LiveSurfaceTargets | null) {
  for (const snapshot of targets?.snapshots ?? []) {
    if (snapshot.value) {
      snapshot.node.style.setProperty(snapshot.name, snapshot.value, snapshot.priority);
    } else {
      snapshot.node.style.removeProperty(snapshot.name);
    }
  }
  for (const node of targets?.createdNodes ?? []) {
    node.remove();
  }
}

function uniqueElements(nodes: HTMLElement[]): HTMLElement[] {
  return [...new Set(nodes)];
}

function readStoredThemeSkinSnapshot(): StoredThemeSkinSnapshot {
  if (typeof localStorage === "undefined") {
    return { skin: DEFAULT_SKIN(), stored: false };
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { skin: DEFAULT_SKIN(), stored: false };
    }
    return { skin: normalizeThemeSkin(JSON.parse(raw) as Partial<ThemeSkinState>), stored: true };
  } catch {
    return { skin: DEFAULT_SKIN(), stored: false };
  }
}

function writeStoredThemeSkin(skin: ThemeSkinState) {
  if (typeof localStorage === "undefined") {
    return;
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeThemeSkin(skin)));
}

function latestPointerPoint(event: ReactPointerEvent<HTMLElement>): {
  clientX: number;
  clientY: number;
} {
  const coalesced = event.nativeEvent.getCoalescedEvents?.();
  const latest = coalesced?.[coalesced.length - 1];
  return latest ?? event;
}

function isPrimaryDragPointer(event: ReactPointerEvent<HTMLElement>): boolean {
  return event.isPrimary && (event.pointerType !== "mouse" || event.button === 0);
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
}

function DEFAULT_SKIN(): ThemeSkinState {
  return normalizeThemeSkin(null);
}

// Same Central family as the rest of the navigation rail (24px grid, 1.5px
// stroke) so the skin switcher no longer carries a one-off bespoke glyph.
function ThemeBrushIcon() {
  return <CentralIcon name="brush" className="size-5" />;
}
