import { createHash } from "node:crypto";
import {
  PAGE_GUEST_EDIT_LIMITS as limits,
  type PageGuestEditEvent,
  type PageGuestEditTicket,
} from "@moss/contracts";
import { GuestProjectionError } from "./guestProjectionContent";
import type { ProjectionObservation } from "./guestProjectionSessions";

/** Only validated control events cross this stream. Each admitted stream holds
 * one slot and one timer; cancellation removes both without waiting for SQLite. */
export class PageGuestEditStreams {
  private readonly streams = new Map<string, AbortController>();
  private closed = false;

  async open(
    ticket: PageGuestEditTicket,
    request: AbortSignal,
    currentIssuer: () => boolean,
    admit: (signal: AbortSignal) => Promise<ProjectionObservation>,
  ): Promise<ReadableStream<Uint8Array>> {
    if (this.closed || request.aborted || !currentIssuer())
      throw new GuestProjectionError("unavailable");
    const key = createHash("sha256").update(ticket.sessionKey).update(ticket.epoch).digest("hex");
    if (this.streams.has(key) || this.streams.size >= limits.streams)
      throw new GuestProjectionError("rate-limited");
    const lifetime = new AbortController();
    this.streams.set(key, lifetime);
    const stop = () => lifetime.abort();
    request.addEventListener("abort", stop, { once: true });
    const cleanup = () => {
      request.removeEventListener("abort", stop);
      if (this.streams.get(key) === lifetime) this.streams.delete(key);
    };
    try {
      const observation = await admit(lifetime.signal);
      if (lifetime.signal.aborted || !currentIssuer() || observation.expires <= Date.now())
        throw new GuestProjectionError("unavailable");
      return new ReadableStream<Uint8Array>(
        {
          start(controller) {
            const encoder = new TextEncoder();
            let timer: ReturnType<typeof setTimeout> | undefined;
            const expiry = setTimeout(
              () => finish("ended"),
              Math.max(1, observation.expires - Date.now()),
            );
            let unsubscribe = () => {};
            let output = 0;
            let checking = false;
            let dirty = false;
            let finished = false;
            const send = (event?: PageGuestEditEvent) => {
              const bytes = encoder.encode(
                event ? "data: " + JSON.stringify(event) + "\n\n" : ": keepalive\n\n",
              );
              output += bytes.byteLength;
              if (
                output <= limits.streamBytes &&
                (controller.desiredSize ?? 0) > -limits.streamBytes
              )
                controller.enqueue(bytes);
            };
            const finish = (event?: "ended" | "refresh") => {
              if (finished) return;
              finished = true;
              clearTimeout(timer);
              clearTimeout(expiry);
              unsubscribe();
              lifetime.signal.removeEventListener("abort", cancel);
              cleanup();
              try {
                if (event) send({ v: 1, type: event });
                controller.close();
              } catch {
                /* browser canceled */
              }
              lifetime.abort();
            };
            const cancel = () => finish();
            lifetime.signal.addEventListener("abort", cancel, { once: true });
            const schedule = () => {
              clearTimeout(timer);
              timer = setTimeout(
                wake,
                Math.max(1, Math.min(limits.heartbeatMs, observation.expires - Date.now())),
              );
            };
            async function check() {
              if (finished) return;
              if (!currentIssuer() || observation.expires <= Date.now()) return finish("ended");
              if (checking) {
                dirty = true;
                return;
              }
              checking = true;
              try {
                const state = await observation.check(lifetime.signal);
                if (finished) return;
                if (!currentIssuer() || observation.expires <= Date.now() || state === "ended")
                  finish("ended");
                else if (state === "refresh") finish("refresh");
                else if (!dirty && state === "ready") send();
              } catch {
                finish("ended");
              } finally {
                checking = false;
                if (!finished) {
                  if (dirty) {
                    dirty = false;
                    queueMicrotask(wake);
                  } else schedule();
                }
              }
            }
            function wake() {
              void check();
            }
            unsubscribe = observation.listen(() => queueMicrotask(wake));
            send({ v: 1, type: "ready", revision: observation.revision });
            queueMicrotask(wake);
          },
          cancel: stop,
        },
        new ByteLengthQueuingStrategy({ highWaterMark: limits.streamBytes }),
      );
    } catch (error) {
      cleanup();
      stop();
      throw error;
    }
  }

  close() {
    this.closed = true;
    for (const lifetime of this.streams.values()) lifetime.abort();
  }
}
