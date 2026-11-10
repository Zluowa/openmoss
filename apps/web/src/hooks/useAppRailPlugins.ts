// FILE: useAppRailPlugins.ts
// Purpose: Account-scoped plugin pins and recent shortcuts, with lazy local discovery.
// Layer: Web navigation state
import { codexAccountInstanceId } from "@moss/shared/providerInstances";
import { useQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import {
  serverMossAccountSessionQueryOptions,
  serverMossCloudAccountStateQueryOptions,
} from "~/components/auth/mossServerReactQuery";
import { commonAppRailPlugins, type AppRailPlugin } from "~/lib/appRailPlugins";
import { serverSettingsQueryOptions } from "~/lib/serverReactQuery";
import { providerPluginsQueryOptions } from "~/lib/providerDiscoveryReactQuery";
import { useLocalStorage } from "./useLocalStorage";

const PluginPreferences = Schema.Record(
  Schema.String,
  Schema.Struct({
    pinned: Schema.Array(
      Schema.Struct({ id: Schema.String, name: Schema.String, description: Schema.String }),
    ),
    recent: Schema.Array(Schema.String),
  }),
);
const EMPTY_PREFERENCES: typeof PluginPreferences.Type = {};

export function useAppRailPlugins(discover: boolean) {
  const phone = useQuery(serverMossAccountSessionQueryOptions());
  const cloud = useQuery(serverMossCloudAccountStateQueryOptions());
  const settings = useQuery(serverSettingsQueryOptions());
  const accountKey = phone.data?.authenticated
    ? `phone:${phone.data.session?.user.id ?? "anonymous"}`
    : cloud.data?.authenticated
      ? `cloud:${cloud.data.account?.id ?? "anonymous"}`
      : "anonymous";
  const [preferences, setPreferences] = useLocalStorage(
    "moss:rail-plugins:v1",
    EMPTY_PREFERENCES,
    PluginPreferences,
  );
  const saved = preferences[accountKey] ?? { pinned: [], recent: [] };
  const mossId = codexAccountInstanceId("moss");
  const mossInstance = settings.data?.providerInstances[mossId];
  const instanceId =
    mossInstance?.driver === "codex" &&
    mossInstance.enabled !== false &&
    mossInstance.config !== null &&
    typeof mossInstance.config === "object" &&
    "managed" in mossInstance.config &&
    mossInstance.config.managed === true
      ? mossId
      : null;
  const options = providerPluginsQueryOptions({
    provider: "codex",
    instanceId,
    cwd: null,
    marketplaceKinds: ["local"],
    enabled: (discover || saved.pinned.length > 0) && settings.isSuccess,
  });
  const plugins = useQuery({
    ...options,
    queryKey: [...options.queryKey, "rail", accountKey],
    // Never show the previous account's directory while the next account loads.
    placeholderData: () => undefined,
    retry: false,
  });
  return {
    items: commonAppRailPlugins({ result: plugins.data, ...saved }),
    pinned: saved.pinned,
    togglePin: (plugin: AppRailPlugin) =>
      setPreferences((previous) => {
        const current = previous[accountKey] ?? { pinned: [], recent: [] };
        return {
          ...previous,
          [accountKey]: {
            ...current,
            pinned: current.pinned.some(({ id }) => id === plugin.id)
              ? current.pinned.filter(({ id }) => id !== plugin.id)
              : [...current.pinned, plugin],
          },
        };
      }),
    recordOpen: (id: string) =>
      setPreferences((previous) => {
        const current = previous[accountKey] ?? { pinned: [], recent: [] };
        return {
          ...previous,
          [accountKey]: {
            ...current,
            recent: [id, ...current.recent.filter((entry) => entry !== id)].slice(0, 24),
          },
        };
      }),
  };
}
