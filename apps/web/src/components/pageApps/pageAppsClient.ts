// FILE: pageAppsClient.ts
// Purpose: The shell's HTTP client for 应用页: JSON requests to
// /api/page-apps/<op> and Server-Sent-Event streams for `watch`.
// Layer: Web pageApps

import type {
  PageAppCallError,
  PageAppsCallInput,
  PageAppsCallResult,
  PageAppsConsentInput,
  PageAppsConsentResult,
  PageAppsListInput,
  PageAppsListResult,
  PageAppsMutateInput,
  PageAppsMutateResult,
  PageAppsOpenFrameInput,
  PageAppsOpenFrameResult,
  PageAppsReadInput,
  PageAppsReadResult,
  PageAppsVersionsInput,
  PageAppsVersionsResult,
} from "@moss/contracts";
import { PageAppCapabilityError } from "@moss/shared/pageAppCapabilityPlugin";

import { resolveWsHttpUrl } from "~/lib/wsHttpUrl";

async function post<T>(op: string, body: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(resolveWsHttpUrl(`/api/page-apps/${op}`), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch {
    throw new PageAppCapabilityError("unavailable", "无法连接到 Moss。");
  }
  const json = (await response.json().catch(() => null)) as
    | (T & { error?: undefined })
    | { error?: { code?: string; message?: string } }
    | null;
  if (!response.ok || !json || (json as { error?: unknown }).error) {
    const error = (json as { error?: { code?: string; message?: string } } | null)?.error;
    throw new PageAppCapabilityError(
      error?.code ?? "unavailable",
      error?.message ?? `HTTP ${response.status}`,
    );
  }
  return json as T;
}

export interface PageAppsWatchSink {
  readonly next: (value: unknown) => void;
  readonly end: (error?: PageAppCallError) => void;
}

/** Opens `watch`; returns cancel. `end` fires exactly once. */
export function watchPageApp(input: PageAppsCallInput, sink: PageAppsWatchSink): () => void {
  const controller = new AbortController();
  let ended = false;
  const finish = (error?: PageAppCallError) => {
    if (ended) return;
    ended = true;
    sink.end(error);
  };
  void (async () => {
    let response: Response;
    try {
      response = await fetch(resolveWsHttpUrl("/api/page-apps/watch"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
    } catch {
      if (!controller.signal.aborted) finish({ code: "unavailable", message: "无法连接到 Moss。" });
      return;
    }
    if (!response.ok || !response.body) {
      const json = (await response.json().catch(() => null)) as { error?: PageAppCallError } | null;
      finish(json?.error ?? { code: "unavailable", message: `HTTP ${response.status}` });
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          let event = "message";
          let data = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          const parsed = data ? JSON.parse(data) : null;
          if (event === "error") finish(parsed as PageAppCallError);
          else if (event === "end") finish();
          else if (!ended) sink.next(parsed);
        }
      }
      finish();
    } catch {
      if (!controller.signal.aborted) finish({ code: "unavailable", message: "连接中断。" });
    }
  })();
  return () => {
    ended = true;
    controller.abort();
  };
}

export const pageAppsClient = {
  list: (input: PageAppsListInput) => post<PageAppsListResult>("list", input),
  read: (input: PageAppsReadInput) => post<PageAppsReadResult>("read", input),
  versions: (input: PageAppsVersionsInput) => post<PageAppsVersionsResult>("versions", input),
  mutate: (input: PageAppsMutateInput, signal?: AbortSignal) =>
    post<PageAppsMutateResult>("mutate", input, signal),
  consent: (input: PageAppsConsentInput) => post<PageAppsConsentResult>("consent", input),
  openFrame: (input: PageAppsOpenFrameInput) => post<PageAppsOpenFrameResult>("open-frame", input),
  call: (input: PageAppsCallInput, signal?: AbortSignal) =>
    post<PageAppsCallResult>("call", input, signal),
  watch: watchPageApp,
};

export type PageAppsClient = typeof pageAppsClient;
