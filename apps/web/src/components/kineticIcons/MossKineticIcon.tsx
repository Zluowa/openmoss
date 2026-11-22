// FILE: MossKineticIcon.tsx
// Purpose: Renders an optical-parity 24x24 outline kinetic icon with active/settled states and smooth tool-to-tool morphing.
// Layer: Web UI presentation component
// Exports: MossKineticIconProps, MossKineticIcon

import { memo, useEffect, useId, useRef, useState } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";
import { renderKineticIconBody, type MossKineticIconId } from "./kineticIconDefinitions";
import { buildKineticTransitionFrame, KINETIC_MORPH_DURATION_MS } from "./kineticTransitionEngine";

export interface MossKineticIconProps {
  readonly name: MossKineticIconId;
  readonly active?: boolean;
  readonly morph?: boolean;
  readonly className?: string;
  readonly label?: string;
  readonly "data-testid"?: string;
}

interface MorphProgressState {
  readonly from: MossKineticIconId;
  readonly to: MossKineticIconId;
  readonly progress: number;
}

export const MossKineticIcon = memo(function MossKineticIcon(props: MossKineticIconProps) {
  const active = props.active ?? false;
  const morph = props.morph ?? false;
  const { name, className, label } = props;
  const testId = props["data-testid"];

  const rawId = useId();
  const clipPrefix = `moss-ki-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");

  const settledNameRef = useRef<MossKineticIconId>(name);
  const [morphState, setMorphState] = useState<MorphProgressState | null>(null);

  useEffect(() => {
    const previous = settledNameRef.current;
    if (!morph || !active || reducedMotion || previous === name) {
      settledNameRef.current = name;
      setMorphState(null);
      return;
    }

    let rafId = 0;
    const startMs = performance.now();
    const tick = (nowMs: number) => {
      const raw = Math.min(1, Math.max(0, (nowMs - startMs) / KINETIC_MORPH_DURATION_MS));
      if (raw >= 0.999) {
        settledNameRef.current = name;
        setMorphState(null);
        return;
      }
      setMorphState({ from: previous, to: name, progress: raw });
      rafId = window.requestAnimationFrame(tick);
    };

    setMorphState({ from: previous, to: name, progress: 0 });
    rafId = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(rafId);
      settledNameRef.current = name;
    };
  }, [name, morph, active, reducedMotion]);

  const effectiveActive = active && !reducedMotion;
  const isMorphing = effectiveActive && morphState !== null && morphState.to === name;
  const morphFrame = isMorphing
    ? buildKineticTransitionFrame(morphState.from, morphState.to, morphState.progress)
    : null;

  return (
    <svg
      data-slot="moss-kinetic-icon"
      data-kinetic-icon={name}
      data-active={effectiveActive ? "true" : "false"}
      data-testid={testId}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn(
        "moss-ki",
        isMorphing ? "moss-ki--morph" : `moss-ki--${name}`,
        "inline-block shrink-0",
        className,
      )}
    >
      {morphFrame
        ? morphFrame.groups.map((group) => (
            <g
              key={group.key}
              opacity={group.opacity}
              style={{
                transformBox: "view-box",
                transformOrigin: "12px 12px",
                ...(group.transform ? { transform: group.transform } : {}),
              }}
            >
              {group.paths.map((layer) => (
                <path
                  key={layer.key}
                  d={layer.d}
                  strokeWidth={layer.strokeWidth}
                  opacity={layer.opacity}
                  strokeDasharray={layer.strokeDasharray}
                  strokeDashoffset={layer.strokeDashoffset}
                />
              ))}
            </g>
          ))
        : renderKineticIconBody(name, clipPrefix)}
    </svg>
  );
});
