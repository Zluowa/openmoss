import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A library deletion survives backfills from retained media bills/history.
  yield* sql`CREATE TABLE IF NOT EXISTS library_media_deletions (item_id TEXT PRIMARY KEY)`;
});
