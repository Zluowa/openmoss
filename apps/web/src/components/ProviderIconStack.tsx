// FILE: ProviderIconStack.tsx
// Purpose: Overlapping agent marks for something several agents share or did: the skill copies
//   in Settings › Skills, the agents that reported the same note in Agent feedback.
// Layer: Shared UI component
// Exports: ProviderIconStack

import type { ProviderKind } from "@moss/contracts";

import { cn } from "~/lib/utils";

import { ProviderIcon } from "./ProviderIcon";

const SIZE_CLASS = {
  sm: { stack: "-space-x-1", tile: "size-4", icon: "size-3" },
  md: { stack: "-space-x-2", tile: "size-6", icon: "size-3.5" },
} as const;

export function ProviderIconStack(props: {
  readonly providers: ReadonlyArray<ProviderKind>;
  /** Read by screen readers and shown on hover. */
  readonly label: string;
  readonly size?: keyof typeof SIZE_CLASS;
  readonly className?: string;
}) {
  if (props.providers.length === 0) return null;
  const size = SIZE_CLASS[props.size ?? "sm"];
  return (
    <span
      className={cn("inline-flex shrink-0 items-center", size.stack, props.className)}
      role="img"
      aria-label={props.label}
      title={props.label}
    >
      {props.providers.map((provider) => (
        <span
          key={provider}
          className={cn(
            "inline-flex items-center justify-center rounded-full border border-background bg-background",
            size.tile,
          )}
        >
          <ProviderIcon provider={provider} className={size.icon} />
        </span>
      ))}
    </span>
  );
}
