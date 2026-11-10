// FILE: PageAppThumbnail.tsx
// Purpose: An 应用页 card image: the stored thumbnail, or a quiet generated
// placeholder (initial on a tint derived from the id) until one exists.
// Layer: Web pageApps

import type { PageApp } from "@moss/contracts";
import { useState } from "react";

import { AppsIcon } from "~/lib/icons";

export function pageAppPlaceholderHue(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

export function PageAppThumbnail({
  app,
}: {
  readonly app: Pick<PageApp, "id" | "title" | "thumbnail">;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  if (app.thumbnail && failed !== app.thumbnail) {
    return (
      <img
        src={app.thumbnail}
        onError={() => setFailed(app.thumbnail)}
        alt=""
        className="aspect-[16/10] w-full object-cover"
        draggable={false}
      />
    );
  }
  const hue = pageAppPlaceholderHue(app.id);
  return (
    <div
      aria-hidden
      className="flex aspect-[16/10] w-full items-center justify-center"
      style={{
        background: `color-mix(in srgb, hsl(${hue} 45% 55%) 14%, var(--color-background-surface))`,
        color: `hsl(${hue} 30% 50%)`,
      }}
    >
      <AppsIcon className="size-6 opacity-70" />
    </div>
  );
}
