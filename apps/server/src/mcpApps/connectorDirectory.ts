// FILE: connectorDirectory.ts
// Purpose: Connector status for the directory (worker D): `interactiveToolCount` and per-tool
//   `hasUi` / `visibility`, from the tool list Moss last read. A connected connector Moss has not
//   listed yet is listed first, within a short bound, so the first directory view already has it.
// Layer: Server MCP Apps runtime (Effect)
// Exports: decorateMcpConnectorsWithApps

import type { McpConnector } from "@moss/contracts";
import { Duration, Effect, Option } from "effect";

import type { McpConnectorsShape } from "../mcpConnectors/Services/McpConnectors.ts";
import { McpAppService } from "./Services/McpAppService.ts";

const FIRST_LISTING_WAIT_MS = 3_000;

export const decorateMcpConnectorsWithApps =
  (connectors: McpConnectorsShape) => (list: ReadonlyArray<McpConnector>) =>
    Effect.gen(function* () {
      const service = Option.getOrUndefined(yield* Effect.serviceOption(McpAppService));
      if (!service) return list;
      const unlisted = list.filter(
        (connector) =>
          connector.status === "connected" &&
          service.connectorTools(connector.connectorId) === undefined,
      );
      if (unlisted.length > 0) {
        yield* Effect.promise(() =>
          Promise.all(
            unlisted.map((connector) =>
              service.refreshConnectorTools(connector.connectorId, (request) =>
                Effect.runPromise(
                  connectors.forward(connector.connectorId, request),
                  request.signal ? { signal: request.signal } : undefined,
                ),
              ),
            ),
          ),
        ).pipe(Effect.timeout(Duration.millis(FIRST_LISTING_WAIT_MS)), Effect.ignore);
      }
      return service.decorateConnectors(list);
    });
