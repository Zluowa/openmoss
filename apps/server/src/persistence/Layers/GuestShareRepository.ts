import { GuestShareId, ThreadGuestMessage, ThreadId } from "@synara/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  GuestShareRecord,
  GuestShareRepository,
  GuestShareSentMessage,
  type GuestShareRepositoryShape,
} from "../Services/GuestShareRepository.ts";

// The row carries its JSON columns as strings; the record decodes them, and a
// write request encodes them the same way.
const GuestShareDbRow = Schema.Struct({
  ...GuestShareRecord.fields,
  messages: Schema.fromJsonString(Schema.Array(ThreadGuestMessage)),
  sentMessages: Schema.fromJsonString(Schema.Array(GuestShareSentMessage)),
});

const makeGuestShareRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = sql.literal(`
    share_id AS "id",
    thread_id AS "threadId",
    relay_origin AS "relayOrigin",
    created_at AS "createdAt",
    expires_at AS "expiresAt",
    guest_name AS "guestName",
    guest_joined_at AS "guestJoinedAt",
    messages_json AS "messages",
    sent_messages_json AS "sentMessages"
  `);

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: GuestShareDbRow,
    execute: () => sql`SELECT ${columns} FROM guest_shares ORDER BY created_at ASC, share_id ASC`,
  });

  const getRowById = SqlSchema.findOneOption({
    Request: GuestShareId,
    Result: GuestShareDbRow,
    execute: (shareId) => sql`SELECT ${columns} FROM guest_shares WHERE share_id = ${shareId}`,
  });

  const getRowByThreadId = SqlSchema.findOneOption({
    Request: ThreadId,
    Result: GuestShareDbRow,
    execute: (threadId) => sql`SELECT ${columns} FROM guest_shares WHERE thread_id = ${threadId}`,
  });

  const insertRow = SqlSchema.void({
    Request: GuestShareDbRow,
    execute: (record) => sql`
      INSERT INTO guest_shares (
        share_id,
        thread_id,
        relay_origin,
        created_at,
        expires_at,
        guest_name,
        guest_joined_at,
        messages_json,
        sent_messages_json
      )
      VALUES (
        ${record.id},
        ${record.threadId},
        ${record.relayOrigin},
        ${record.createdAt},
        ${record.expiresAt},
        ${record.guestName},
        ${record.guestJoinedAt},
        ${record.messages},
        ${record.sentMessages}
      )
    `,
  });

  const updateRow = SqlSchema.findOneOption({
    Request: GuestShareDbRow,
    Result: Schema.Struct({ id: GuestShareId }),
    execute: (record) => sql`
      UPDATE guest_shares SET
        expires_at = ${record.expiresAt},
        guest_name = ${record.guestName},
        guest_joined_at = ${record.guestJoinedAt},
        messages_json = ${record.messages},
        sent_messages_json = ${record.sentMessages}
      WHERE share_id = ${record.id}
      RETURNING share_id AS "id"
    `,
  });

  const deleteRow = SqlSchema.void({
    Request: GuestShareId,
    execute: (shareId) => sql`DELETE FROM guest_shares WHERE share_id = ${shareId}`,
  });

  const list: GuestShareRepositoryShape["list"] = () =>
    listRows().pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "GuestShareRepository.list:query",
          "GuestShareRepository.list:decodeRows",
        ),
      ),
    );

  const getById: GuestShareRepositoryShape["getById"] = (shareId) =>
    getRowById(shareId).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "GuestShareRepository.getById:query",
          "GuestShareRepository.getById:decodeRow",
        ),
      ),
    );

  const getByThreadId: GuestShareRepositoryShape["getByThreadId"] = (threadId) =>
    getRowByThreadId(threadId).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "GuestShareRepository.getByThreadId:query",
          "GuestShareRepository.getByThreadId:decodeRow",
        ),
      ),
    );

  const insert: GuestShareRepositoryShape["insert"] = (record) =>
    insertRow(record).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "GuestShareRepository.insert:query",
          "GuestShareRepository.insert:encodeRow",
        ),
      ),
    );

  const update: GuestShareRepositoryShape["update"] = (record) =>
    updateRow(record).pipe(
      Effect.map(Option.isSome),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "GuestShareRepository.update:query",
          "GuestShareRepository.update:encodeRow",
        ),
      ),
    );

  const deleteById: GuestShareRepositoryShape["deleteById"] = (shareId) =>
    deleteRow(shareId).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "GuestShareRepository.deleteById:query",
          "GuestShareRepository.deleteById:encodeRow",
        ),
      ),
    );

  return {
    list,
    getById,
    getByThreadId,
    insert,
    update,
    deleteById,
  } satisfies GuestShareRepositoryShape;
});

export const GuestShareRepositoryLive = Layer.effect(
  GuestShareRepository,
  makeGuestShareRepository,
);
