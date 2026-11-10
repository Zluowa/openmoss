import { PageGuestViewRequest, type PageId } from "@moss/contracts";
import { Effect, Layer, Option, Schema, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore";
import { PageRealtimeService } from "../realtime/PageRealtimeService";
import { GUEST_FRAME_LIMIT, InvalidGuestFrame } from "../realtime/guestRoomFrame";
import { copyOrdinaryByteView } from "../realtime/ordinaryByteView";
import { makePageRoomReservations } from "../realtime/pageRoomReservations";
import { PageSharingService } from "../sharing/PageSharingService";
import { PageGuestFailure, pageGuestFailure } from "../sharing/pageGuestHandler";
import { commitGuestPageFrame } from "./commitGuestPageFrame";
import { PAGE_GUEST_AUTHOR_KEY_PURPOSE } from "./pageGuestAuthor";

export interface GuestPageRealtimeWrite {
  readonly entry: PageGuestViewRequest;
  readonly pageId: PageId;
  readonly generation: string;
  readonly update: Uint8Array;
}
export interface GuestPageRealtimeWriteResult {
  readonly revision: number;
  readonly applied: boolean;
}
export interface GuestPageRealtimeWriterShape {
  readonly write: (
    input: GuestPageRealtimeWrite,
  ) => Effect.Effect<GuestPageRealtimeWriteResult, PageGuestFailure>;
}
export class GuestPageRealtimeWriter extends ServiceMap.Service<
  GuestPageRealtimeWriter,
  GuestPageRealtimeWriterShape
>()("moss/pages/guestEditing/GuestPageRealtimeWriter") {}

/** Internal writer only. An existing seeded room supplies the generation and frozen
 * baseline. The caller supplies original proof and update bytes only. */
export const GuestPageRealtimeWriterLive = Layer.effect(
  GuestPageRealtimeWriter,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sharing = yield* PageSharingService;
    const realtime = yield* PageRealtimeService;
    const secrets = yield* ServerSecretStore;
    const lifetime = yield* makePageRoomReservations();
    const pending = new Map<string, number>();
    let active = 0;
    yield* Effect.addFinalizer(() => lifetime.close);

    const write: GuestPageRealtimeWriterShape["write"] = (input) =>
      Effect.suspend(() => {
        let pageId: PageId;
        let generation: string;
        let entry: PageGuestViewRequest;
        let update: Uint8Array<ArrayBuffer>;
        try {
          const { entry: rawEntry, pageId: id, generation: roomGeneration, update: source } = input;
          const parsed = Schema.decodeUnknownOption(PageGuestViewRequest)(rawEntry);
          if (
            Option.isNone(parsed) ||
            typeof id !== "string" ||
            !id ||
            typeof roomGeneration !== "string" ||
            !roomGeneration ||
            roomGeneration.length > 128 ||
            (parsed.value.pageId !== undefined && parsed.value.pageId !== id) ||
            Object.keys(input).some(
              (key) => !["entry", "pageId", "generation", "update"].includes(key),
            ) ||
            Object.keys(rawEntry).some((key) => !["link", "key", "visitor", "pageId"].includes(key))
          )
            return Effect.fail(pageGuestFailure("invalid"));
          if (active >= 32 || (pending.get(id) ?? 0) >= 4)
            return Effect.fail(pageGuestFailure("unavailable"));
          const copy = copyOrdinaryByteView(source, GUEST_FRAME_LIMIT, 1);
          if (!copy) return Effect.fail(pageGuestFailure("invalid"));
          pageId = id;
          generation = roomGeneration;
          entry = parsed.value;
          update = copy;
        } catch {
          return Effect.fail(pageGuestFailure("invalid"));
        }
        active++;
        pending.set(pageId, (pending.get(pageId) ?? 0) + 1);
        return lifetime
          .withPage(
            pageId,
            Effect.gen(function* () {
              const key = yield* secrets.getOrCreateRandom(PAGE_GUEST_AUTHOR_KEY_PURPOSE, 32);
              if (key.byteLength !== 32) return yield* pageGuestFailure("unavailable");
              return yield* realtime.transactGuestFrame(pageId, generation, update, (cut, scope) =>
                commitGuestPageFrame(sql, sharing, { entry, pageId, scope, key, cut }),
              );
            }),
          )
          .pipe(
            Effect.timeoutOrElse({
              duration: "5 seconds",
              onTimeout: () => Effect.fail(pageGuestFailure("unavailable")),
            }),
            Effect.mapError((cause) =>
              cause instanceof PageGuestFailure
                ? cause
                : pageGuestFailure(cause instanceof InvalidGuestFrame ? "invalid" : "unavailable"),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                active--;
                const left = (pending.get(pageId) ?? 1) - 1;
                if (left) pending.set(pageId, left);
                else pending.delete(pageId);
              }),
            ),
          );
      });
    return { write };
  }),
);
