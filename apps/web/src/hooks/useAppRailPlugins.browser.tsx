// FILE: useAppRailPlugins.browser.tsx
// Purpose: Account switches must not show a previous account's plugins or saved pins.
// Layer: Web hook browser tests
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const read = vi.hoisted(() => vi.fn());
vi.mock("~/nativeApi", () => ({ ensureNativeApi: () => ({ provider: { listPlugins: read } }) }));
vi.mock("~/components/auth/mossServerReactQuery", () => ({
  serverMossAccountSessionQueryOptions: () => ({
    queryKey: ["rail-test", "account"],
    queryFn: async () => ({ authenticated: false }),
  }),
  serverMossCloudAccountStateQueryOptions: () => ({
    queryKey: ["rail-test", "cloud"],
    queryFn: async () => ({ authenticated: false }),
  }),
}));
vi.mock("~/lib/serverReactQuery", () => ({
  serverSettingsQueryOptions: () => ({
    queryKey: ["rail-test", "settings"],
    queryFn: async () => ({ providerInstances: {} }),
  }),
}));
import { useAppRailPlugins } from "./useAppRailPlugins";

function Harness() {
  const plugins = useAppRailPlugins(true);
  return (
    <>
      <span data-testid="common-plugins">{plugins.items.map(({ name }) => name).join(",")}</span>
      <span data-testid="pinned-plugins">{plugins.pinned.map(({ name }) => name).join(",")}</span>
      <button onClick={() => plugins.items[0] && plugins.togglePin(plugins.items[0])}>
        Pin first
      </button>
    </>
  );
}

describe("rail plugin accounts", () => {
  beforeEach(() => {
    localStorage.removeItem("moss:rail-plugins:v1");
    read.mockReset();
  });
  it("keeps pins separate and clears the old directory immediately while the next account loads", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(["rail-test", "account"], {
      authenticated: true,
      session: { user: { id: "a" } },
    });
    client.setQueryData(["rail-test", "cloud"], { authenticated: false });
    client.setQueryData(["rail-test", "settings"], { providerInstances: {} });
    read.mockResolvedValueOnce({
      marketplaces: [{ plugins: [{ id: "figma@test", name: "Figma", installed: true }] }],
    });
    const mounted = await render(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    );
    await expect.element(page.getByTestId("common-plugins")).toHaveTextContent("Figma");
    await page.getByRole("button", { name: "Pin first", exact: true }).click();
    await expect.element(page.getByTestId("pinned-plugins")).toHaveTextContent("Figma");
    let finish!: (value: unknown) => void;
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    client.setQueryData(["rail-test", "account"], {
      authenticated: true,
      session: { user: { id: "b" } },
    });
    await expect.element(page.getByTestId("common-plugins")).toHaveTextContent("");
    await expect.element(page.getByTestId("pinned-plugins")).toHaveTextContent("");
    finish({ marketplaces: [] });
    client.setQueryData(["rail-test", "account"], {
      authenticated: true,
      session: { user: { id: "a" } },
    });
    await expect.element(page.getByTestId("pinned-plugins")).toHaveTextContent("Figma");
    await mounted.unmount();
    client.clear();
  });
});
