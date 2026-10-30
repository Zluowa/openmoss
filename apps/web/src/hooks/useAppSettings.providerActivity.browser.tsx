import "../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_SERVER_SETTINGS_VIEW } from "@synara/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const api = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  refreshProviders: vi.fn(),
}));
vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({ server: api }),
  readNativeApi: () => undefined,
}));

import { useAppSettings } from "~/appSettings";
import { formatMossTranslation } from "~/localization";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { ProviderActivitySettings } from "~/components/settings/ProviderActivitySettings";

afterEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  vi.clearAllMocks();
});

it("propagates a real settings save failure to the CLI switch and recovers on retry", async () => {
  localStorage.setItem("moss:server-settings-migrated:v1", "1");
  let serverSettings = structuredClone(DEFAULT_SERVER_SETTINGS_VIEW);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(serverQueryKeys.settings(), serverSettings);
  api.getSettings.mockImplementation(async () => serverSettings);
  api.refreshProviders.mockResolvedValue({ providers: [] });
  api.updateSettings
    .mockRejectedValueOnce(new Error("injected rejected settings write"))
    .mockImplementation(async () => {
      serverSettings = {
        ...serverSettings,
        providers: {
          ...serverSettings.providers,
          hermes: { ...serverSettings.providers.hermes, enabled: true },
        },
      };
      return serverSettings;
    });
  function Harness() {
    const binding = useAppSettings();
    return (
      <ProviderActivitySettings
        settings={binding.settings}
        defaults={binding.defaults}
        ready={Boolean(binding.serverSettings)}
        updateSettingsAndWait={binding.updateSettingsAndWait}
      />
    );
  }
  await render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>,
  );
  const enable = formatMossTranslation("en", "settings.providers.activity.enableAria", {
    provider: "Hermes",
  });
  const disable = formatMossTranslation("en", "settings.providers.activity.disableAria", {
    provider: "Hermes",
  });
  await page.getByRole("switch", { name: enable, exact: true }).click();
  await expect.element(page.getByRole("alert")).toBeVisible();
  await expect.element(page.getByRole("switch", { name: enable, exact: true })).toBeEnabled();
  expect(api.updateSettings).toHaveBeenCalledTimes(1);
  await page.getByRole("switch", { name: enable, exact: true }).click();
  await expect.element(page.getByRole("switch", { name: disable, exact: true })).toBeChecked();
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  expect(api.updateSettings).toHaveBeenCalledTimes(2);
  queryClient.clear();
});
