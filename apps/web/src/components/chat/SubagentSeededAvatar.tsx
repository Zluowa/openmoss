// FILE: SubagentSeededAvatar.tsx
// Purpose: Codex-compatible deterministic subagent avatar primitive.
// Layer: Chat right-dock UI

import { useSyncExternalStore, type ComponentProps } from "react";

import { SUBAGENT_AVATAR_ASSETS, SUBAGENT_AVATAR_ASSET_COUNT } from "./subagentAvatarAssets";
import { cn } from "~/lib/utils";

const AVATAR_HASH_MODULUS = 2_147_483_647;

export function seededSubagentAvatarIndex(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % AVATAR_HASH_MODULUS;
  }
  return hash % SUBAGENT_AVATAR_ASSET_COUNT;
}

/** Backward-compatible name for callers that used the pre-parity primitive. */
export const seededSubagentPaletteIndex = seededSubagentAvatarIndex;

function subscribeTheme(listener: () => void): () => void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
    return () => undefined;
  }
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme-variant"],
  });
  return () => observer.disconnect();
}

function readTheme(): "light" | "dark" {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark")
    ? "dark"
    : "light";
}

function useDocumentTheme(): "light" | "dark" {
  return useSyncExternalStore(subscribeTheme, readTheme, () => "light");
}

export function SubagentSeededAvatar({
  seed,
  className,
  ...props
}: Omit<ComponentProps<"img">, "alt" | "draggable" | "src"> & { seed: string }) {
  const theme = useDocumentTheme();
  const paletteIndex = seededSubagentAvatarIndex(seed);
  const assetPair = SUBAGENT_AVATAR_ASSETS[paletteIndex];
  if (!assetPair) {
    throw new Error("Subagent avatar asset table is empty");
  }
  const source = assetPair[theme];
  return (
    <img
      {...props}
      className={cn("size-4 shrink-0", className)}
      data-avatar-seed={seed}
      data-avatar-palette-index={paletteIndex}
      data-avatar-theme={theme}
      alt=""
      draggable={false}
      src={source}
    />
  );
}
