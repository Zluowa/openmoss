// FILE: ai.ts
// Purpose: Server half of the `ai` capability: validates the request, keeps a
// per-page budget, and streams the model's answer.
// Layer: Server pages/apps

import {
  PAGE_APP_AI_MAX_INPUT_CHARS,
  PageAppAiRequest,
  type PageAppAiEvent,
} from "@moss/contracts";
import { PageAppCapabilityError, toPageAppCallError } from "@moss/shared/pageAppCapabilityPlugin";
import { Schema, Stream } from "effect";

import type { PageAppAiGateway } from "../aiGateway";
import type { PageAppServerCapability } from "./types";

const MAX_CONCURRENT_PER_APP = 2;
const MAX_PER_MINUTE_PER_APP = 30;

export function makeAiCapability(deps: { readonly ai: PageAppAiGateway }): PageAppServerCapability {
  const running = new Map<string, number>();
  const recent = new Map<string, number[]>();
  const admit = (appId: string) => {
    const now = Date.now();
    const window = (recent.get(appId) ?? []).filter((at) => now - at < 60_000);
    if (
      (running.get(appId) ?? 0) >= MAX_CONCURRENT_PER_APP ||
      window.length >= MAX_PER_MINUTE_PER_APP
    ) {
      throw new PageAppCapabilityError(
        "resource_exhausted",
        "Too many AI requests from this page; slow down.",
      );
    }
    window.push(now);
    recent.set(appId, window);
    running.set(appId, (running.get(appId) ?? 0) + 1);
    return () => running.set(appId, Math.max(0, (running.get(appId) ?? 1) - 1));
  };
  return {
    name: "ai",
    consent: "standing",
    watch: (ctx, method, args) => {
      if (method !== "ask")
        return Stream.fail(
          new PageAppCapabilityError("invalid_argument", `ai has no "${method}".`),
        );
      let request: PageAppAiRequest;
      try {
        request = Schema.decodeUnknownSync(PageAppAiRequest)(args);
      } catch {
        return Stream.fail(new PageAppCapabilityError("invalid_argument", "Malformed ai request."));
      }
      const size =
        (typeof request.input === "string"
          ? request.input.length
          : request.input.reduce((sum, message) => sum + message.content.length, 0)) +
        (request.system?.length ?? 0);
      if (size > PAGE_APP_AI_MAX_INPUT_CHARS)
        return Stream.fail(
          new PageAppCapabilityError("invalid_argument", "The ai input is too long."),
        );
      async function* run(): AsyncGenerator<PageAppAiEvent> {
        const release = admit(ctx.app.id);
        const controller = new AbortController();
        try {
          yield* deps.ai.ask(request, controller.signal);
        } finally {
          controller.abort();
          release();
        }
      }
      return Stream.fromAsyncIterable(run(), (cause) => {
        const error = toPageAppCallError(cause);
        return new PageAppCapabilityError(error.code, error.message);
      });
    },
  };
}
