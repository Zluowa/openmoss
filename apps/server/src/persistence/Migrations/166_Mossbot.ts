import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

// Personal assistants share the durable Hub runtime. Existing Hubs stay Hubs.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* columnExists(sql, "project_agent_configs", "agent_kind"))) {
    yield* sql`ALTER TABLE project_agent_configs ADD COLUMN agent_kind TEXT NOT NULL DEFAULT 'hub' CHECK (agent_kind IN ('hub', 'mossbot'))`;
  }
});
