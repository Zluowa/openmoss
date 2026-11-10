import { QueryClient } from "@tanstack/react-query";
import { expect, it } from "vitest";

import {
  MCP_CONNECTORS_QUERY_KEY,
  MOSS_SERVICE_PLUGINS_QUERY_KEY,
} from "./mcpConnectorsReactQuery";

it("refreshes the service plugin list whenever the Connectors list is refreshed", async () => {
  const client = new QueryClient();
  client.setQueryData(MCP_CONNECTORS_QUERY_KEY, []);
  client.setQueryData(MOSS_SERVICE_PLUGINS_QUERY_KEY, { installed: ["amap"], skills: [] });

  // Settings → Connectors invalidates only its own key after a connect or disconnect.
  await client.invalidateQueries({ queryKey: MCP_CONNECTORS_QUERY_KEY });

  expect(client.getQueryState(MOSS_SERVICE_PLUGINS_QUERY_KEY)?.isInvalidated).toBe(true);
});
