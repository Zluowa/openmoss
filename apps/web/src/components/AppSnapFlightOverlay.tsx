// FILE: AppSnapFlightOverlay.tsx
// Purpose: Renders the GPU-composited fly-to-composer thumbnail preview and subtle
//          capture-arrival veil when a live AppSnap lands in Moss's chat composer.
// Layer: Root web motion overlay
// Depends on: appSnapArrival state machine and pure FLIP geometry helpers.

import { useEffect, useState, useSyncExternalStore, type CSSProperties } from "react";

import {
  type AppSnapFlightPayload,
  type AppSnapFlightRect,
  type AppSnapFlightVector,
  completeAppSnapFlight,
  computeAppSnapFlightVector,
  getActiveAppSnapFlight,
  predecodeAppSnapPreview,
  subscribeAppSnapArrival,
  waitForAppSnapVisibleFrame,
} from "~/lib/appSnapArrival";
import { WindowIcon } from "~/lib/icons";

const MAX_TARGET_LOOKUP_FRAMES = 16;
const FLIGHT_END_SAFETY_MS = 90;

interface MeasuredFlight {
  readonly captureId: string;
  readonly targetRect: AppSnapFlightRect;
  readonly vector: AppSnapFlightVector;
}

function escapeAttributeValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function findCaptureTargetRect(captureId: string): AppSnapFlightRect | null {
  if (typeof document === "undefined") return null;
  const selector = `[data-appsnap-capture-id="${escapeAttributeValue(captureId)}"]`;
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function formatFlightProvenance(flight: AppSnapFlightPayload): string {
  const appName = flight.appName.trim() || "Captured app";
  const windowTitle = flight.windowTitle?.trim() || null;
  if (
    windowTitle &&
    windowTitle.localeCompare(appName, undefined, { sensitivity: "accent" }) !== 0
  ) {
    return `${windowTitle} / ${appName}`;
  }
  return appName;
}

export function AppSnapFlightOverlay() {
  const flight = useSyncExternalStore(subscribeAppSnapArrival, getActiveAppSnapFlight, () => null);
  const [measured, setMeasured] = useState<MeasuredFlight | null>(null);

  useEffect(() => {
    if (!flight) {
      setMeasured(null);
      return;
    }

    let cancelled = false;
    let rafId: number | null = null;
    let completionTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      if (cancelled) return;
      cancelled = true;
      setMeasured(null);
      completeAppSnapFlight(flight.captureId);
    };

    const startFlight = (targetRect: AppSnapFlightRect) => {
      if (cancelled) return;
      const vector = computeAppSnapFlightVector({
        targetRect,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
        },
        sourceWindowBounds: flight.sourceWindowBounds,
        screenWidth: window.screen?.availWidth ?? window.screen?.width,
      });
      setMeasured({
        captureId: flight.captureId,
        targetRect,
        vector,
      });
      completionTimer = setTimeout(finish, vector.durationMs + FLIGHT_END_SAFETY_MS);
    };

    const resolveTarget = (remainingFrames: number) => {
      if (cancelled) return;
      const rect = findCaptureTargetRect(flight.captureId);
      if (rect) {
        startFlight(rect);
        return;
      }
      if (remainingFrames <= 0 || typeof requestAnimationFrame !== "function") {
        finish();
        return;
      }
      rafId = requestAnimationFrame(() => resolveTarget(remainingFrames - 1));
    };

    void Promise.all([
      waitForAppSnapVisibleFrame(),
      predecodeAppSnapPreview(flight.previewUrl),
    ]).then(() => {
      if (!cancelled) {
        resolveTarget(MAX_TARGET_LOOKUP_FRAMES);
      }
    });

    return () => {
      cancelled = true;
      if (rafId !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(rafId);
      }
      if (completionTimer !== null) {
        clearTimeout(completionTimer);
      }
    };
  }, [flight]);

  if (!flight || !measured || measured.captureId !== flight.captureId) {
    return null;
  }

  const provenance = formatFlightProvenance(flight);
  const cardStyle = {
    left: `${measured.targetRect.left}px`,
    top: `${measured.targetRect.top}px`,
    width: `${measured.targetRect.width}px`,
    height: `${measured.targetRect.height}px`,
    "--appsnap-fly-dx": `${measured.vector.startDx}px`,
    "--appsnap-fly-dy": `${measured.vector.startDy}px`,
    "--appsnap-fly-scale": String(measured.vector.startScale),
    "--appsnap-fly-mid-dx": `${measured.vector.midDx}px`,
    "--appsnap-fly-mid-dy": `${measured.vector.midDy}px`,
    "--appsnap-fly-mid-scale": String(measured.vector.midScale),
    "--appsnap-fly-duration": `${measured.vector.durationMs}ms`,
  } as CSSProperties;

  return (
    <div
      data-testid="appsnap-flight-overlay"
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-[220] overflow-hidden"
    >
      {flight.withReturnVeil ? (
        <div
          data-testid="appsnap-flight-veil"
          className="appsnap-flight-veil pointer-events-none absolute inset-0"
        />
      ) : null}
      <div
        data-testid="appsnap-flight-card"
        data-appsnap-flight-capture-id={flight.captureId}
        style={cardStyle}
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget) {
            completeAppSnapFlight(flight.captureId);
          }
        }}
        className="appsnap-flight-card pointer-events-none fixed overflow-hidden rounded-card border border-primary/65 bg-[var(--color-background-secondary)] shadow-2xl shadow-black/25"
      >
        <div className="relative flex size-full items-center justify-center overflow-hidden bg-[var(--color-background-secondary)] p-1">
          <img
            src={flight.previewUrl}
            alt=""
            className="max-h-full max-w-full rounded-control object-contain"
          />
          <span className="pointer-events-none absolute inset-x-0 bottom-0 flex min-w-0 items-end gap-2 bg-linear-to-t from-black/90 via-black/55 to-transparent px-2.5 pb-2 pt-10 text-left">
            {flight.appIconDataUrl ? (
              <img
                src={flight.appIconDataUrl}
                alt=""
                className="size-5 shrink-0 rounded-inline object-contain shadow-sm"
              />
            ) : (
              <span className="flex size-5 shrink-0 items-center justify-center rounded-inline bg-white/15 text-white/85 backdrop-blur-sm">
                <WindowIcon className="size-3" aria-hidden="true" />
              </span>
            )}
            <span className="min-w-0 flex-1 truncate pb-px text-ui-sm font-medium text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.8)]">
              {provenance}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
