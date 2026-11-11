// FILE: useImportTurnedOffAgents.ts
// Purpose: The agents switched off on the agents list, as the server has them, for the import
//          panel. Unknown (undefined) until server settings load: the local default switches
//          every optional agent off, so using it early would hide agents the person turned on.
// Layer: React hook over the server settings query

import type { ProviderKind } from "@moss/contracts";
import { useQuery } from "@tanstack/react-query";

import { getServerDisabledProviders } from "~/appSettings";
import { serverSettingsQueryOptions } from "~/lib/serverReactQuery";

export function useImportTurnedOffAgents(): readonly ProviderKind[] | undefined {
  const serverSettings = useQuery(serverSettingsQueryOptions()).data;
  return serverSettings ? getServerDisabledProviders(serverSettings) : undefined;
}
