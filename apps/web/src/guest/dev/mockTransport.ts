// FILE: mockTransport.ts
// Purpose: A fake relay for developing and screenshotting the guest page without an owner.
// Layer: Guest page dev harness (never bundled for production)
// Usage: open the dev server at `/s/<any id>?mock=<scenario>[#invite]`. Scenarios:
//   name     — no session; the name form redeems any invite, then the thread streams
//   used     — like `name`, but the invite was spent (redeem → 409 used)
//   invalid  — no session and no invite: the link is dead
//   live     — joined; a running thread with work log, a plan, a streaming reply, own messages
//   idle     — joined; the same thread, settled
//   offline  — joined; the stream drops and the owner stays offline
//   ended    — joined; the share ends shortly after the snapshot
// Add `&lang=zh-CN|en` for the fixture language (defaults to the page locale), `&pending=3`
// for a composer at the waiting-message limit, `&name=` for the guest's name.

import type {
  GuestAccessErrorReason,
  GuestStreamEvent,
  ThreadGuestMessage,
} from "@synara/contracts";

import { resolveGuestLocale } from "../guestStream.logic";
import type { GuestFailure, GuestStreamHandlers, GuestTransport } from "../transport";
import {
  FIXTURE_SNAPSHOT_SEQUENCE,
  guestFixture,
  streamingReplyEvent,
  type GuestFixture,
} from "./fixtures";

const http = (status: number, reason: GuestAccessErrorReason, message: string): GuestFailure => ({
  kind: "http",
  status,
  reason,
  message,
});

const OWNER_OFFLINE = http(503, "owner_offline", "The owner's Moss is offline.");
const NO_SESSION = http(403, "invalid", "This guest link is not valid.");

// A small picture so attachment thumbnails have something to show.
const SAMPLE_IMAGE =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#dfe8df"/><rect x="40" y="40" width="560" height="320" rx="24" fill="#f6f8f6"/><text x="320" y="210" font-family="sans-serif" font-size="36" text-anchor="middle" fill="#3f5a3f">screenshot</text></svg>',
  );

export function createMockGuestTransport(scenario: string, shareId: string): GuestTransport {
  const params = new URLSearchParams(window.location.search);
  const locale = resolveGuestLocale([params.get("lang") ?? navigator.language]);
  const guestName = params.get("name") ?? (locale === "zh-CN" ? "小林" : "Sam");
  const settled = scenario === "idle" || scenario === "ended";
  let joined = !["name", "used", "invalid"].includes(scenario);
  let ownerOffline = false;
  let fixture: GuestFixture | null = null;
  let sequence = FIXTURE_SNAPSHOT_SEQUENCE;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (callback: () => void, delayMs: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      callback();
    }, delayMs);
    timers.add(timer);
  };
  let streamHandlers: GuestStreamHandlers | null = null;
  const emit = (event: GuestStreamEvent) => streamHandlers?.onEvent(event);

  const currentFixture = (name = guestName): GuestFixture => {
    if (fixture === null) {
      fixture = guestFixture({
        locale,
        shareId,
        guestName: name,
        phase: settled ? "idle" : "running",
      });
      const extraPending = Number(params.get("pending") ?? 0) - 1;
      if (extraPending > 0) {
        const template = fixture.view.messages.find((message) => message.status === "pending");
        const extras: ThreadGuestMessage[] = Array.from({ length: extraPending }, (_, index) => ({
          id: `g-extra-${index}` as ThreadGuestMessage["id"],
          text: `${template?.text ?? "…"} (${index + 2})`,
          status: "pending",
          submittedAt: new Date().toISOString(),
          attachments: [],
        }));
        fixture = {
          ...fixture,
          view: { ...fixture.view, messages: [...fixture.view.messages, ...extras] },
        };
      }
    }
    return fixture;
  };

  const sendOpening = () => {
    const data = currentFixture();
    emit({ type: "hello", protocolVersion: 1 });
    emit({ type: "view", view: data.view });
    emit({ type: "thread", item: { kind: "snapshot", snapshot: data.snapshot } });
  };

  // As the owner's stream does: each streaming frame carries the new slice of text, and the
  // closing frame carries the whole message.
  const streamReply = () => {
    const data = currentFixture();
    let shown = 0;
    const step = () => {
      const next = Math.min(data.streamingText.length, shown + 3 + Math.floor(Math.random() * 4));
      const done = next >= data.streamingText.length;
      const text = done ? data.streamingText : data.streamingText.slice(shown, next);
      shown = next;
      sequence += 1;
      emit({
        type: "thread",
        item: { kind: "event", event: streamingReplyEvent(data, text, !done, sequence) },
      });
      if (!done) later(step, 60 + Math.random() * 90);
    };
    later(step, 1200);
  };

  return {
    async probeSession() {
      if (ownerOffline) return { ok: false, failure: OWNER_OFFLINE };
      return joined ? { ok: true } : { ok: false, failure: NO_SESSION };
    },
    async redeem(_credential, name) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      if (scenario === "used") return http(409, "used", "This guest link was already used.");
      currentFixture(name);
      joined = true;
      return null;
    },
    async submit(text, files) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const data = currentFixture();
      const pending = data.view.messages.filter((message) => message.status === "pending");
      if (pending.length >= 3) {
        return http(409, "busy", "Wait for the owner to answer your earlier messages.");
      }
      const message: ThreadGuestMessage = {
        id: `g-${Date.now()}` as ThreadGuestMessage["id"],
        text,
        status: "pending",
        submittedAt: new Date().toISOString(),
        attachments: files.map((file, index) => ({
          type: file.type.startsWith("image/") ? "image" : "file",
          id: `att-${Date.now()}-${index}` as never,
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
        })),
      };
      fixture = {
        ...data,
        view: { ...data.view, messages: [...data.view.messages, message] },
      };
      later(() => emit({ type: "view", view: currentFixture().view }), 200);
      return null;
    },
    openStream(handlers) {
      streamHandlers = handlers;
      if (ownerOffline) {
        later(() => handlers.onError(), 300);
        return () => {
          streamHandlers = null;
        };
      }
      later(() => {
        sendOpening();
        switch (scenario) {
          case "offline":
            later(() => {
              ownerOffline = true;
              handlers.onError();
            }, 1200);
            break;
          case "ended":
            later(() => emit({ type: "ended", reason: "closed" }), 1200);
            break;
          case "idle":
            break;
          default:
            streamReply();
        }
      }, 400);
      return () => {
        streamHandlers = null;
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
      };
    },
    attachmentUrl() {
      return SAMPLE_IMAGE;
    },
  };
}
