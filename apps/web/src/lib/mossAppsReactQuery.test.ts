import { QueryClient } from "@tanstack/react-query";
import { expect, it } from "vitest";
import {
  mossAppConnectionsQueryOptions,
  mossAppsStatusQueryOptions,
  MOSS_APP_CONNECTIONS_QUERY_KEY,
} from "./mossAppsReactQuery";
import { mossAppsErrorMessage } from "./mossAppsCopy";
import { serverMossCloudLogoutMutationOptions } from "~/components/auth/mossServerReactQuery";

const gitHubConnection = {
  connectionId: "ca_a",
  toolkitSlug: "github",
  status: "active",
  createdAt: "2026-11-06T00:00:00.000Z",
} as const;

it("partitions connections and availability without putting tokens in query keys", async () => {
  const client = new QueryClient();
  const a = mossAppConnectionsQueryOptions({
    enabled: true,
    polling: false,
    accountKey: "global:a",
  });
  const b = mossAppConnectionsQueryOptions({
    enabled: true,
    polling: false,
    accountKey: "global:b",
  });
  client.setQueryData(a.queryKey, { connections: [gitHubConnection] });
  expect(client.getQueryData(b.queryKey)).toBeUndefined();
  expect(mossAppsStatusQueryOptions({ accountKey: "global:a" }).queryKey).not.toEqual(
    mossAppsStatusQueryOptions({ accountKey: "global:b" }).queryKey,
  );
  await client.invalidateQueries({ queryKey: MOSS_APP_CONNECTIONS_QUERY_KEY });
  expect(client.getQueryState(a.queryKey)?.isInvalidated).toBe(true);
  client.clear();
});

it("localizes stable failures and never shows raw provider errors", () => {
  expect(mossAppsErrorMessage({ code: "authentication_required" }, "zh-CN")).toBe(
    "登录 Moss 后即可连接你的应用。",
  );
  expect(mossAppsErrorMessage(new Error("Your Moss account changed. Try again."), "zh-CN")).toBe(
    "Moss 账号已切换，请重试。",
  );
  expect(mossAppsErrorMessage(new Error("secret-provider-error"), "zh-CN")).not.toContain(
    "secret-provider-error",
  );
  expect(mossAppsErrorMessage({ code: "apps_login_account_required" }, "zh-CN")).toContain(
    "手机或 Google 账号",
  );
});

it("clears private Apps snapshots through the existing logout cache callback", async () => {
  const client = new QueryClient();
  const connections = mossAppConnectionsQueryOptions({
    enabled: true,
    polling: false,
    accountKey: "a",
  }).queryKey;
  const status = mossAppsStatusQueryOptions({ accountKey: "a" }).queryKey;
  client.setQueryData(connections, { connections: [gitHubConnection] });
  client.setQueryData(status, { availability: "ready", agentAccess: true });
  client.setQueryData(["mossApps", "catalog"], { toolkits: [] });
  const mutation = serverMossCloudLogoutMutationOptions({ queryClient: client });
  await (mutation.onSuccess as () => Promise<void>)();
  expect(client.getQueryData(connections)).toBeUndefined();
  expect(client.getQueryData(status)).toBeUndefined();
  expect(client.getQueryData(["mossApps", "catalog"])).toEqual({ toolkits: [] });
  client.clear();
});
