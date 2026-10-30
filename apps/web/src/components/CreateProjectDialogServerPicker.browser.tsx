import "../index.css";

import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  type ExecutionEnvironmentDescriptor,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import { MossLocalizationProvider } from "~/localization";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { APP_SETTINGS_STORAGE_KEY } from "~/uiLocale";

const nativeApi = vi.hoisted(() => ({
  pickFolder: vi.fn<() => Promise<string | null>>(() => Promise.resolve(null)),
}));

vi.mock("../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../env")>()),
  // This file exercises the browser path: no Electron preload bridge, so the
  // picker layout is gated on the server-advertised capability instead.
  isElectron: false,
}));

vi.mock("../nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../nativeApi")>()),
  // Stands in for the wsNativeApi server-RPC fallback: the dialog only cares
  // that a picker callable exists.
  readNativeApi: () => ({
    dialogs: {
      pickFolder: nativeApi.pickFolder,
    },
  }),
}));

import { CreateProjectDialog } from "./CreateProjectDialog";

type CreateProjectDialogProps = ComponentProps<typeof CreateProjectDialog>;

function environmentWithFolderPicker(folderPicker: boolean): ExecutionEnvironmentDescriptor {
  return {
    environmentId: "env-test",
    label: "Test server",
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "0.0.0-test",
    capabilities: { repositoryIdentity: true, folderPicker },
  } as unknown as ExecutionEnvironmentDescriptor;
}

async function renderDialog(environment: ExecutionEnvironmentDescriptor) {
  localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride: "en" }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);
  // staleTime is Infinity for the environment query, so seeded data is never
  // refetched and no real transport is needed.
  queryClient.setQueryData(serverQueryKeys.environment(), environment);
  const props: CreateProjectDialogProps = {
    open: true,
    activeSpaceId: null,
    onOpenChange: vi.fn(),
    onSubmit: vi.fn().mockResolvedValue(undefined),
  };
  await render(
    <QueryClientProvider client={queryClient}>
      <MossLocalizationProvider>
        <CreateProjectDialog {...props} />
      </MossLocalizationProvider>
    </QueryClientProvider>,
  );
  return props;
}

describe("CreateProjectDialog (browser, server-hosted folder picker)", () => {
  afterEach(async () => {
    nativeApi.pickFolder.mockClear();
    nativeApi.pickFolder.mockResolvedValue(null);
    localStorage.clear();
    await cleanup();
  });

  it("renders the Codex picker layout outside Electron when the server offers a picker", async () => {
    nativeApi.pickFolder.mockResolvedValue("/Users/test/Developer/moss-app");
    await renderDialog(environmentWithFolderPicker(true));

    // The picker affordances of the Codex form: location dropdown + Add button.
    await expect.element(page.getByLabelText("Folder location")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Add", exact: true })).toBeVisible();
    // …and no typed-path fallback.
    expect(page.getByRole("textbox", { name: "Project folder path" }).elements()).toHaveLength(0);

    await page.getByRole("button", { name: "Add", exact: true }).click();
    await vi.waitFor(() => expect(nativeApi.pickFolder).toHaveBeenCalledOnce());
    await expect.element(page.getByText("moss-app", { exact: true })).toBeVisible();
  });

  it("keeps the typed-path fallback when the server has no picker", async () => {
    await renderDialog(environmentWithFolderPicker(false));

    await expect.element(page.getByRole("textbox", { name: "Project folder path" })).toBeVisible();
    expect(page.getByRole("button", { name: "Add", exact: true }).elements()).toHaveLength(0);
    expect(page.getByLabelText("Folder location").elements()).toHaveLength(0);
  });
});
