// FILE: inlineVisualizationFrameUrl.ts
// Purpose: Ask the server to validate a Codex visualization marker and mint its frame URL.
// Layer: Web transport helper

import { resolveWsHttpUrl } from "./wsHttpUrl";

export async function resolveInlineVisualizationFrameUrl(input: {
  readonly threadId: string | undefined;
  readonly path: string | undefined;
}): Promise<string | null> {
  if (!input.threadId || !input.path) return null;
  const params = new URLSearchParams({ threadId: input.threadId, path: input.path });
  try {
    const response = await fetch(
      resolveWsHttpUrl(`/api/inline-visualization?${params.toString()}`),
      {
        credentials: "include",
        headers: { Accept: "application/json" },
      },
    );
    if (!response.ok) return null;
    const value: unknown = await response.json();
    if (
      !value ||
      typeof value !== "object" ||
      typeof (value as { url?: unknown }).url !== "string"
    ) {
      return null;
    }
    return (value as { url: string }).url;
  } catch {
    return null;
  }
}
