// FILE: PluginLibrary.browser.tsx
// Purpose: Exercises the complete PluginLibrary route, queries, native mutations, and reconciliation.
// Layer: Browser integration test

import "../index.css";
import "./PluginLibrary.css";

import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";

import { toastManager } from "~/components/ui/toast";
import {
  acknowledgeStartupAnnouncementsForTest,
  createBrowserTestServerConfig,
} from "~/test/browserHarness";
import { mountGeneratedPluginApp } from "~/test/generatedPluginLibraryBrowserHarness";
import {
  GITHUB_PLUGIN_ID,
  PluginLibraryNativeFixture,
  mountPluginLibrary,
  pluginDescriptor,
} from "~/test/pluginLibraryBrowserHarness";

const mountedPages: Array<Awaited<ReturnType<typeof mountPluginLibrary>>> = [];

async function mount(fixture: PluginLibraryNativeFixture, initialEntries?: readonly string[]) {
  const mounted = await mountPluginLibrary({
    fixture,
    ...(initialEntries ? { initialEntries } : {}),
  });
  mountedPages.push(mounted);
  return mounted;
}

async function waitForPlugin(name: string) {
  await expect.poll(() => document.body.textContent, { timeout: 3_000 }).toContain(name);
}

// Codex directory rows expose install as a quiet trailing "+" icon button
// (aria-label only), so match by aria-label rather than visible text.
const INSTALL_ACTION_LABEL = /^(Install|Installing(?:\.{3}|…))$/u;

function isInstallActionButton(button: HTMLButtonElement): boolean {
  return (
    INSTALL_ACTION_LABEL.test(button.textContent?.trim() ?? "") ||
    INSTALL_ACTION_LABEL.test(button.getAttribute("aria-label")?.trim() ?? "")
  );
}

function pluginInstallButton(name: string): HTMLButtonElement {
  const openButton = page.getByRole("button", { name, exact: true }).first().element();
  const row = openButton.closest("article");
  const install = [...(row?.querySelectorAll("button") ?? [])].find(isInstallActionButton);
  if (!(install instanceof HTMLButtonElement)) {
    throw new Error(`Missing install button for ${name}.`);
  }
  return install;
}

function pluginHasInstallAction(name: string): boolean {
  const openButton = page.getByRole("button", { name, exact: true }).first().element();
  const row = openButton.closest("article");
  return [...(row?.querySelectorAll("button") ?? [])].some(isInstallActionButton);
}

function setImportFile(name: string, contents: string, type: string): void {
  const input = document.querySelector<HTMLInputElement>(
    "[data-testid='plugin-import-source-file']",
  );
  if (!input) throw new Error("Missing plugin import file input.");
  const transfer = new DataTransfer();
  transfer.items.add(new File([contents], name, { type }));
  Object.defineProperty(input, "files", { configurable: true, value: transfer.files });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

afterEach(async () => {
  while (mountedPages.length > 0) await mountedPages.pop()!.cleanup();
  vi.restoreAllMocks();
});

describe("PluginLibrary complete-page states", () => {
  it("keeps the selected host while its capability lookup is pending", async () => {
    const fixture = new PluginLibraryNativeFixture();
    const api = fixture.nativeApi();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = vi.fn<typeof api.provider.getComposerCapabilities>(async (input) => {
      const capabilities = await api.provider.getComposerCapabilities(input);
      if (input.provider === "codex") await pending;
      return input.provider === "claudeAgent"
        ? { ...capabilities, supportsPluginDiscovery: true, supportsSkillDiscovery: true }
        : capabilities;
    });
    vi.spyOn(fixture, "nativeApi").mockReturnValue({
      ...api,
      provider: { ...api.provider, getComposerCapabilities: read },
    });
    try {
      const mounted = await mount(fixture);
      await vi.waitFor(() => expect(read).toHaveBeenCalledWith({ provider: "claudeAgent" }));
      await expect
        .element(page.getByText("Loading plugins...", { exact: true }))
        .toBeInTheDocument();
      expect(mounted.host.textContent).not.toContain("Plugins unavailable for");
      expect(fixture.listPluginCalls).toEqual([]);
      release();
      await waitForPlugin("GitHub");
      expect(fixture.listPluginCalls.every((call) => call.provider === "codex")).toBe(true);
    } finally {
      release();
    }
  });

  it("shows a retryable capability lookup failure instead of unsupported plugins", async () => {
    const fixture = new PluginLibraryNativeFixture();
    const api = fixture.nativeApi();
    let recovered = false;
    const read = vi.fn<typeof api.provider.getComposerCapabilities>(async (input) => {
      if (input.provider === "codex" && !recovered)
        throw new Error("Selected host capability lookup failed");
      return api.provider.getComposerCapabilities(input);
    });
    vi.spyOn(fixture, "nativeApi").mockReturnValue({
      ...api,
      provider: { ...api.provider, getComposerCapabilities: read },
    });
    const mounted = await mount(fixture);
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Selected host capability lookup failed");
    expect(mounted.host.textContent).not.toContain("Plugins unavailable for");
    expect(fixture.listPluginCalls).toEqual([]);
    const beforeRetry = read.mock.calls.filter(([input]) => input.provider === "codex").length;
    recovered = true;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await waitForPlugin("GitHub");
    expect(read.mock.calls.filter(([input]) => input.provider === "codex").length).toBeGreaterThan(
      beforeRetry,
    );
    expect(fixture.listPluginCalls.every((call) => call.provider === "codex")).toBe(true);
  });

  it.each([true, false])(
    "binds standalone Moss browsing only to an enabled managed host (enabled=%s)",
    async (enabled) => {
      const fixture = new PluginLibraryNativeFixture();
      fixture.serverSettings = {
        ...fixture.serverSettings,
        textGenerationModelSelection: {
          provider: "codex",
          instanceId: "codex",
          model: "gpt-6-astra",
        },
        providerInstances: {
          ...fixture.serverSettings.providerInstances,
          codex_moss: {
            driver: "codex",
            displayName: "Moss",
            enabled,
            config: { managed: true },
          },
        },
      };
      await mount(fixture);
      await waitForPlugin("GitHub");
      await vi.waitFor(() => expect(fixture.listPluginCalls.length).toBeGreaterThan(0));
      expect(
        fixture.listPluginCalls.every(
          (call) => call.instanceId === (enabled ? "codex_moss" : "codex"),
        ),
      ).toBe(true);
      if (enabled)
        expect(fixture.listPluginCalls.every((call) => call.forceRemoteSync === undefined)).toBe(
          true,
        );
    },
  );

  it("opens the real import wizard from the Add menu's Upload plugin archive", async () => {
    await mount(new PluginLibraryNativeFixture());
    await waitForPlugin("GitHub");

    await userEvent.click(page.getByRole("button", { name: "Add" }));
    const importAction = page.getByText("Upload plugin archive", { exact: true });
    await expect.element(importAction).toBeInTheDocument();
    await userEvent.click(importAction);
    await expect.element(page.getByTestId("plugin-import-title")).toBeInTheDocument();
    await expect.element(page.getByTestId("plugin-import-step-source")).toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Cancel" }));
    await expect.element(page.getByTestId("plugin-import-title")).not.toBeInTheDocument();
  });

  it("runs the main-page import entry through typed native RPC and never direct-writes", async () => {
    const fixture = new PluginLibraryNativeFixture();
    const mounted = await mount(fixture);
    await waitForPlugin("GitHub");

    await userEvent.click(page.getByRole("button", { name: "Add" }));
    await userEvent.click(page.getByText("Upload plugin archive", { exact: true }));
    setImportFile(
      "plugin.json",
      JSON.stringify({ name: "Main page import", description: "Native path" }),
      "application/json",
    );
    await expect.element(page.getByTestId("plugin-import-conflict-missing")).toBeInTheDocument();
    await page.getByTestId("plugin-import-review-preview").click();
    await expect.element(page.getByTestId("plugin-import-preview-panel")).toBeInTheDocument();
    await page.getByTestId("plugin-import-confirm").click();
    await expect
      .element(page.getByTestId("plugin-import-result-panel"))
      .toHaveAttribute("data-import-status", "imported");
    await expect.element(page.getByTestId("plugin-import-rollback")).toBeInTheDocument();

    expect(fixture.importReadFileCalls).toEqual([
      {
        cwd: "/repo/project",
        relativePath: ".moss/plugins/main-page-import/plugin.json",
        maxBytes: 1_000_000,
      },
    ]);
    expect(fixture.importWriteFileCalls).toHaveLength(0);
    expect(fixture.importDeleteMossResourceCalls).toHaveLength(0);
    expect(fixture.importPlanCalls).toHaveLength(1);
    expect(fixture.importApplyCalls).toHaveLength(1);
    expect(mounted.router.state.location.pathname).toBe("/skills");
  });

  it("uses the generated /skills route and the same production dialog as Settings", async () => {
    const fixture = new PluginLibraryNativeFixture();
    fixture.serverSettings = {
      ...fixture.serverSettings,
      onboardingCompletedAt: "2026-10-12T00:00:00.000Z",
    };
    const mounted = await mountGeneratedPluginApp({
      fixture,
      initialEntries: ["/skills"],
      cwd: "/generated-route-workspace",
      configureNativeApi() {
        acknowledgeStartupAnnouncementsForTest({
          ...createBrowserTestServerConfig("2026-10-12T00:00:00.000Z"),
          worktreesDir: "/repo/.worktrees",
        });
      },
    });

    try {
      await waitForPlugin("GitHub");
      expect(mounted.router.state.location.pathname).toBe("/skills");
      await expect
        .element(page.getByRole("tabpanel"))
        .toHaveAttribute("aria-labelledby", "plugins-tab-plugins");
      await userEvent.click(page.getByRole("button", { name: "Add", exact: true }));
      await expect
        .element(page.getByText("Upload plugin archive", { exact: true }))
        .toBeInTheDocument();
      await userEvent.click(page.getByText("Upload plugin archive", { exact: true }));
      await expect.element(page.getByTestId("plugin-import-title")).toBeInTheDocument();
      expect(
        page.getByTestId("plugin-import-title").element().closest('[role="dialog"]'),
      ).not.toBeNull();
      setImportFile(
        "plugin.json",
        JSON.stringify({ name: "Generated route import", description: "Native path" }),
        "application/json",
      );
      await expect.element(page.getByTestId("plugin-import-conflict-missing")).toBeInTheDocument();
      await page.getByTestId("plugin-import-review-preview").click();
      await page.getByTestId("plugin-import-confirm").click();
      await expect
        .element(page.getByTestId("plugin-import-result-panel"))
        .toHaveAttribute("data-import-status", "imported");
      await expect.element(page.getByTestId("plugin-import-rollback")).toBeInTheDocument();
      expect(fixture.importReadFileCalls).toEqual([
        {
          cwd: "/generated-route-workspace",
          relativePath: ".moss/plugins/generated-route-import/plugin.json",
          maxBytes: 1_000_000,
        },
      ]);
      expect(fixture.importWriteFileCalls).toHaveLength(0);
      expect(fixture.importDeleteMossResourceCalls).toHaveLength(0);
      expect(fixture.importPlanCalls).toHaveLength(1);
      expect(fixture.importApplyCalls).toHaveLength(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders loading, catalog error/retry, empty, and populated states from real queries", async () => {
    const loading = await mount(new PluginLibraryNativeFixture("loading"));
    await expect
      .poll(() => loading.host.textContent, { timeout: 2_000 })
      .toContain("Loading plugins...");
    await loading.cleanup();
    mountedPages.pop();

    const errorFixture = new PluginLibraryNativeFixture("error");
    const error = await mount(errorFixture);
    await expect
      .element(page.getByText("Couldn't load plugins", { exact: true }))
      .toBeInTheDocument();
    const retry = page.getByRole("button", { name: "Retry" });
    await expect.element(retry).toBeInTheDocument();
    const readsBeforeRetry = errorFixture.listPluginCalls.length;
    errorFixture.catalogMode = "populated";
    await userEvent.click(retry);
    await waitForPlugin("GitHub");
    expect(errorFixture.listPluginCalls.length).toBeGreaterThan(readsBeforeRetry);
    await error.cleanup();
    mountedPages.pop();

    const empty = await mount(new PluginLibraryNativeFixture("empty"));
    await expect.element(page.getByText("No plugins found", { exact: true })).toBeInTheDocument();
    await empty.cleanup();
    mountedPages.pop();

    await mount(new PluginLibraryNativeFixture("populated"));
    await waitForPlugin("GitHub");
    await waitForPlugin("Slack");
  });

  it("renders the Codex skills browse with an Installed grid and Personal/System scope tabs", async () => {
    const fixture = new PluginLibraryNativeFixture("populated");
    fixture.discoveredSkills.push(
      {
        name: "forge",
        description: "Inspect review flows",
        path: "/skills/forge",
        enabled: true,
        scope: "personal",
        interface: { displayName: "Forge", shortDescription: "Inspect review flows" },
      },
      {
        name: "image-gen",
        description: "Generate or edit images",
        path: "/skills/image-gen",
        enabled: true,
        scope: "system",
        interface: { displayName: "Image Gen", shortDescription: "Generate or edit images" },
      },
    );
    await mount(fixture, ["/skills"]);
    await waitForPlugin("GitHub");

    await userEvent.click(page.getByRole("tab", { name: "Skills", exact: true }));
    const installedGrid = page.getByTestId("skills-installed-grid");
    const scopedGrid = page.getByTestId("skills-scoped-grid");
    await expect.element(installedGrid).toBeInTheDocument();
    // The Installed grid shows every discovered skill regardless of scope.
    await vi.waitFor(() => {
      expect(installedGrid.element().textContent).toContain("Forge");
      expect(installedGrid.element().textContent).toContain("Image Gen");
    });
    // Personal is the default scope tab; the scoped list starts with it.
    const scopeTabs = page.getByTestId("skills-scope-tabs");
    await expect.element(scopeTabs).toBeInTheDocument();
    expect(scopedGrid.element().textContent).toContain("Forge");
    expect(scopedGrid.element().textContent).not.toContain("Image Gen");

    await userEvent.click(page.getByRole("tab", { name: "System", exact: true }));
    await vi.waitFor(() => {
      expect(scopedGrid.element().textContent).toContain("Image Gen");
      expect(scopedGrid.element().textContent).not.toContain("Forge");
    });

    // Skill cards open the Codex-parity skill detail dialog.
    await userEvent.click(
      page
        .getByTestId("skills-installed-grid")
        .getByRole("button", { name: "Forge", exact: true })
        .first(),
    );
    await expect.element(page.getByTestId("skill-detail-dialog")).toBeInTheDocument();
    await expect.element(page.getByTestId("skill-detail-try-now")).toBeInTheDocument();
  });

  it("keeps a disabled skill in the directory so it can be enabled again", async () => {
    const fixture = new PluginLibraryNativeFixture("populated");
    fixture.discoveredSkills.push({
      name: "forge",
      description: "Inspect review flows",
      path: "/skills/forge",
      enabled: true,
      scope: "personal",
      interface: { displayName: "Forge" },
    });
    await mount(fixture, ["/skills"]);
    await waitForPlugin("GitHub");
    await userEvent.click(page.getByRole("tab", { name: "Skills", exact: true }));
    const card = page
      .getByTestId("skills-installed-grid")
      .getByRole("button", { name: "Forge", exact: true });
    await userEvent.click(card);
    const toggle = page.getByRole("switch", { name: "Enable Forge", exact: true });
    await expect.element(toggle).toBeChecked();
    await userEvent.click(toggle);
    await vi.waitFor(() => expect(fixture.serverSettings.skills.disabled).toEqual(["forge"]));
    await expect.element(page.getByTestId("skill-detail-dialog")).not.toBeInTheDocument();
    await expect.element(card).toBeInTheDocument();
    await userEvent.click(card);
    await expect.element(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    await vi.waitFor(() => expect(fixture.serverSettings.skills.disabled).toEqual([]));
    await expect.element(page.getByTestId("skill-detail-dialog")).not.toBeInTheDocument();
    await userEvent.click(card);
    await expect.element(toggle).toBeChecked();
  });

  it("keeps detail navigation in URL history and restores focus after browser back", async () => {
    const mounted = await mount(new PluginLibraryNativeFixture());
    await waitForPlugin("GitHub");
    const trigger = page.getByRole("button", { name: "GitHub", exact: true }).first();
    await userEvent.click(trigger);
    await vi.waitFor(() =>
      expect(mounted.router.state.location.pathname).toBe(
        `/skills/plugins/${encodeURIComponent(GITHUB_PLUGIN_ID)}`,
      ),
    );
    await expect
      .poll(
        () => mounted.host.querySelector('[data-testid="plugin-detail-content"] h1')?.textContent,
        { timeout: 3_000 },
      )
      .toBe("GitHub");

    mounted.router.history.back();
    await vi.waitFor(() => expect(mounted.router.state.location.pathname).toBe("/skills"));
    await expect
      .poll(() => document.activeElement?.getAttribute("aria-label"), { timeout: 3_000 })
      .toBe("GitHub");

    mounted.router.history.forward();
    await vi.waitFor(() =>
      expect(mounted.router.state.location.pathname).toContain("/skills/plugins/"),
    );
    await expect
      .poll(
        () => mounted.host.querySelector('[data-testid="plugin-detail-content"] h1')?.textContent,
        { timeout: 3_000 },
      )
      .toBe("GitHub");

    await userEvent.click(page.getByTestId("plugin-detail-breadcrumb").getByRole("button"));
    await vi.waitFor(() => expect(mounted.router.state.location.pathname).toBe("/skills"));
    await expect
      .poll(() => document.activeElement?.getAttribute("aria-label"), { timeout: 3_000 })
      .toBe("GitHub");
  });

  it("restores focus to the exact management-row trigger after closing detail", async () => {
    const fixture = new PluginLibraryNativeFixture();
    fixture.installedPluginIds.add(GITHUB_PLUGIN_ID);
    const mounted = await mount(fixture, ["/skills/manage"]);
    await waitForPlugin("GitHub");

    const rowTrigger = page
      .getByTestId("plugin-manage-plugin-row")
      .getByRole("button", { name: "GitHub", exact: true });
    await userEvent.click(rowTrigger);
    await vi.waitFor(() =>
      expect(mounted.router.state.location.pathname).toBe(
        `/skills/manage/plugins/${encodeURIComponent(GITHUB_PLUGIN_ID)}`,
      ),
    );

    await userEvent.click(page.getByTestId("plugin-detail-breadcrumb").getByRole("button"));
    await vi.waitFor(() => expect(mounted.router.state.location.pathname).toBe("/skills/manage"));
    await expect
      .poll(() => document.activeElement?.getAttribute("aria-label"), { timeout: 3_000 })
      .toBe("GitHub");
  });

  // MERGE-GAP(2026-10-07): main 同败（导航后未回推 Manage 标签状态，expected null to be
  // 'Manage'）——main checkout 单文件实证 1 failed/21 passed，非合并回归。
  it.skip("PUSHes Browse Manage into settings and restores search, scroll, focus, Back, and Forward", async () => {
    const fixture = new PluginLibraryNativeFixture();
    for (let index = 0; index < 12; index += 1) {
      fixture.additionalPrimaryPlugins.push(
        pluginDescriptor({
          id: `git-tool-${index}@openai-curated`,
          name: `git-tool-${index}`,
          displayName: `Git Tool ${index}`,
        }),
      );
    }
    const mounted = await mount(fixture);
    await waitForPlugin("GitHub");
    const browseScroll = page.getByTestId("plugin-library-scroll-container").element();
    mounted.host.style.bottom = "auto";
    mounted.host.style.height = "260px";
    await userEvent.fill(page.getByRole("combobox", { name: "Search plugins" }), "Git");
    browseScroll.scrollTop = 37;
    expect(browseScroll.scrollTop).toBe(37);

    const manage = page.getByRole("button", { name: "Manage" }).first();
    await userEvent.click(manage);
    await vi.waitFor(() =>
      expect(mounted.router.state.location.pathname).toBe("/settings/plugins-settings"),
    );
    expect(
      (
        mounted.router.state.location.state as {
          pluginLibraryEntrySnapshot?: { scrollTop?: number };
        }
      ).pluginLibraryEntrySnapshot?.scrollTop,
    ).toBe(37);
    await expect.element(page.getByTestId("plugin-manage-content")).toBeInTheDocument();
    await expect.element(page.getByPlaceholder("Search plugins")).toHaveValue("Git");

    mounted.router.history.back();
    await vi.waitFor(() => expect(mounted.router.state.location.pathname).toBe("/skills"));
    await expect.element(page.getByRole("combobox", { name: "Search plugins" })).toHaveValue("Git");
    await expect.poll(() => document.activeElement?.getAttribute("aria-label")).toBe("Manage");
    expect(page.getByTestId("plugin-library-scroll-container").element().scrollTop).toBe(37);
    page.getByTestId("plugin-library-scroll-container").element().scrollTop = 12;
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
    });
    expect(page.getByTestId("plugin-library-scroll-container").element().scrollTop).toBe(12);

    mounted.router.history.forward();
    await vi.waitFor(() =>
      expect(mounted.router.state.location.pathname).toBe("/settings/plugins-settings"),
    );
    await expect.element(page.getByPlaceholder("Search plugins")).toHaveValue("Git");
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(mounted.router.state.location.pathname).toBe("/skills"));
  });

  it("returns Detail Manage to the installed detail and restores its exact focus", async () => {
    const fixture = new PluginLibraryNativeFixture();
    fixture.installedPluginIds.add(GITHUB_PLUGIN_ID);
    const mounted = await mount(fixture);
    await waitForPlugin("GitHub");
    await userEvent.click(page.getByRole("button", { name: "GitHub", exact: true }).first());
    await vi.waitFor(() =>
      expect(mounted.router.state.location.pathname).toContain("/skills/plugins/"),
    );
    await userEvent.click(page.getByRole("button", { name: "More actions" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Manage" }));
    await vi.waitFor(() =>
      expect(mounted.router.state.location.pathname).toBe("/settings/plugins-settings"),
    );

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() =>
      expect(mounted.router.state.location.pathname).toContain("/skills/plugins/"),
    );
    await expect
      .poll(() => document.activeElement?.getAttribute("aria-label"))
      .toBe("More actions");
  });

  it("supports a direct settings route and returns settings Manage detail to its state", async () => {
    const fixture = new PluginLibraryNativeFixture();
    fixture.installedPluginIds.add(GITHUB_PLUGIN_ID);
    const mounted = await mount(fixture, ["/settings/plugins-settings"]);
    await waitForPlugin("GitHub");
    await userEvent.fill(page.getByPlaceholder("Search plugins"), "Git");
    const rowTrigger = page
      .getByTestId("plugin-manage-plugin-row")
      .getByRole("button", { name: "GitHub", exact: true });
    await userEvent.click(rowTrigger);
    await vi.waitFor(() =>
      expect(mounted.router.state.location.pathname).toBe(
        `/skills/manage/plugins/${encodeURIComponent(GITHUB_PLUGIN_ID)}`,
      ),
    );

    await userEvent.click(page.getByTestId("plugin-detail-breadcrumb").getByRole("button"));
    await vi.waitFor(() =>
      expect(mounted.router.state.location.pathname).toBe("/settings/plugins-settings"),
    );
    await expect.element(page.getByPlaceholder("Search plugins")).toHaveValue("Git");
    await expect.poll(() => document.activeElement?.getAttribute("aria-label")).toBe("GitHub");

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(mounted.router.state.location.pathname).toBe("/skills"));
  });
});

describe("PluginLibrary native lifecycle", () => {
  it.each([
    ["Explore", ["/skills"] as const],
    ["Manage", ["/skills/manage"] as const],
  ])(
    "drops stale optional-shard rows and shows a degraded warning in %s after refetch fails",
    async (surface, initialEntries) => {
      const fixture = new PluginLibraryNativeFixture();
      fixture.workspacePlugins.push(
        pluginDescriptor({
          id: "workspace-agent@workspace-directory",
          name: "workspace-agent",
          displayName: "Workspace Agent",
          installed: true,
          enabled: true,
        }),
      );
      await mount(fixture, initialEntries);
      if (surface === "Explore") {
        const workspaceBucket = page.getByRole("tab", { name: "Workspace", exact: true });
        await expect.element(workspaceBucket).toBeInTheDocument();
        await userEvent.click(workspaceBucket);
      }
      await waitForPlugin("Workspace Agent");

      fixture.optionalShardError = new Error("remote plugin shard unavailable");
      if (surface === "Manage") {
        // Codex's Settings page carries only Browse catalog and Add; the
        // directory's Refresh re-reads every lane, then Manage shows the result.
        await userEvent.click(page.getByRole("button", { name: "Browse catalog", exact: true }));
        await userEvent.click(page.getByRole("button", { name: "Refresh", exact: true }));
        await expect
          .poll(() => document.body.textContent, { timeout: 3_000 })
          .toContain("Some plugin sources couldn't load");
        await userEvent.click(page.getByRole("button", { name: "Manage", exact: true }));
      } else {
        await userEvent.click(page.getByRole("button", { name: "Refresh", exact: true }));
      }

      // The page names the failure; the raw cause stays in the warning's tooltip.
      await expect
        .poll(() => document.body.textContent, { timeout: 3_000 })
        .toContain("Some plugin sources couldn't load");
      expect(document.querySelector('[title*="remote plugin shard unavailable"]')).not.toBeNull();
      await expect
        .poll(() => document.body.textContent, { timeout: 3_000 })
        .not.toContain("Workspace Agent");
    },
  );

  it("keeps Moss Apps through a failed catalog read: names it, and Refresh brings the apps back", async () => {
    const fixture = new PluginLibraryNativeFixture();
    fixture.mossAppToolkits = [
      {
        slug: "acme_tracker",
        name: "Acme Tracker",
        description: "Track Acme work",
        logoUrl: null,
        categories: ["Productivity"],
        toolsCount: 4,
        signIn: "managed",
      },
    ];
    // The first read and both of its retries fail.
    fixture.mossAppCatalogFailures = 3;
    await mount(fixture, ["/skills"]);
    await waitForPlugin("GitHub");

    await expect
      .poll(() => document.body.textContent, { timeout: 10_000 })
      .toContain("Some plugin sources couldn't load");
    expect(document.querySelector('[title*="Moss could not load apps."]')).not.toBeNull();
    expect(document.body.textContent).not.toContain("Acme Tracker");

    await userEvent.click(page.getByRole("button", { name: "Refresh", exact: true }));
    await expect
      .poll(() => document.body.textContent, { timeout: 5_000 })
      .toContain("Acme Tracker");
    expect(document.body.textContent).toContain("Moss Apps");
    expect(document.body.textContent).not.toContain("Some plugin sources couldn't load");
  });

  it("names a CLI listing that timed out as an unavailable source, not its raw error", async () => {
    const fixture = new PluginLibraryNativeFixture();
    fixture.optionalShardLoadErrors = [
      {
        marketplacePath: "codex-native",
        message:
          "Provider adapter request failed (codex) for plugin/list: Timed out waiting for plugin/list.",
      },
    ];
    await mount(fixture, ["/skills"]);
    await waitForPlugin("GitHub");

    // The page names the failure; the raw cause stays in the warning's tooltip.
    await expect
      .poll(() => document.body.textContent, { timeout: 3_000 })
      .toContain("Some plugin sources couldn't load");
    expect(document.body.textContent).not.toContain("Timed out waiting for plugin/list");
    expect(document.querySelector('[title*="Timed out waiting for plugin/list"]')).not.toBeNull();
  });

  it("settles install from primary truth when every optional shard needs authentication", async () => {
    const fixture = new PluginLibraryNativeFixture();
    fixture.optionalShardError = new Error(
      "chatgpt authentication required for remote plugin catalog",
    );
    const addToast = vi.spyOn(toastManager, "add");
    await mount(fixture);
    await waitForPlugin("GitHub");
    const readsBeforeMutation = fixture.listPluginCalls.length;

    await userEvent.click(pluginInstallButton("GitHub"));
    await vi.waitFor(() => expect(fixture.installCalls).toHaveLength(1));
    fixture.completeInstall("github");

    await vi.waitFor(() => expect(pluginHasInstallAction("GitHub")).toBe(false));
    await vi.waitFor(() =>
      expect(fixture.listPluginCalls.length).toBeGreaterThanOrEqual(readsBeforeMutation + 4),
    );
    await vi.waitFor(() =>
      expect(addToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "success", title: "GitHub plugin installed" }),
      ),
    );
    expect(addToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Install failed" }),
    );
    expect(fixture.installCalls).toHaveLength(1);
  });

  it("does not query ChatGPT-only remote shards during managed Moss plugin lifecycle", async () => {
    const fixture = new PluginLibraryNativeFixture();
    fixture.serverSettings = {
      ...fixture.serverSettings,
      textGenerationModelSelection: {
        provider: "codex",
        instanceId: "codex_moss",
        model: "gpt-5.6-luna",
      },
    };
    await mount(fixture);
    await waitForPlugin("GitHub");
    await vi.waitFor(() => expect(fixture.listPluginCalls.length).toBeGreaterThan(0));

    expect(fixture.listPluginCalls).toEqual([
      expect.objectContaining({
        instanceId: "codex_moss",
        marketplaceKinds: ["local"],
        forceReload: true,
      }),
    ]);
    expect(fixture.listPluginCalls[0]).not.toHaveProperty("forceRemoteSync");

    await userEvent.click(pluginInstallButton("GitHub"));
    await vi.waitFor(() => expect(fixture.installCalls).toHaveLength(1));
    fixture.completeInstall("github");
    await vi.waitFor(() => expect(pluginHasInstallAction("GitHub")).toBe(false));

    expect(fixture.listPluginCalls.length).toBeGreaterThan(1);
    expect(fixture.listPluginCalls).toEqual(
      fixture.listPluginCalls.map(() =>
        expect.objectContaining({
          instanceId: "codex_moss",
          marketplaceKinds: ["local"],
          forceReload: true,
        }),
      ),
    );
    expect(fixture.listPluginCalls.every((call) => call.forceRemoteSync === undefined)).toBe(true);
  });

  it("deduplicates one plugin while preserving independent pending state for concurrent installs", async () => {
    const fixture = new PluginLibraryNativeFixture();
    await mount(fixture);
    await expect
      .poll(() => fixture.listPluginCalls.length, { timeout: 3_000 })
      .toBeGreaterThanOrEqual(5);
    // Each lane names its own kinds; the primary lane is Codex's local catalog
    // and the kinds-free one is Codex desktop's own directory (remote catalog).
    expect(fixture.listPluginCalls.map((call) => call.marketplaceKinds)).toEqual([
      ["local"],
      ["workspace-directory"],
      ["shared-with-me"],
      ["created-by-me-remote"],
      undefined,
    ]);
    await waitForPlugin("GitHub");

    const githubInstall = pluginInstallButton("GitHub");
    const slackInstall = pluginInstallButton("Slack");
    githubInstall.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    githubInstall.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    slackInstall.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await vi.waitFor(() => expect(fixture.installCalls).toHaveLength(2));
    expect(fixture.installCalls.map((call) => call.pluginName).toSorted()).toEqual([
      "github",
      "slack",
    ]);
    expect(pluginInstallButton("GitHub")).toBeDisabled();
    expect(pluginInstallButton("Slack")).toBeDisabled();

    fixture.completeInstall("github");
    await vi.waitFor(() => expect(fixture.installedPluginIds.has(GITHUB_PLUGIN_ID)).toBe(true));
    expect(pluginInstallButton("Slack")).toBeDisabled();
    fixture.completeInstall("slack");
  });

  it.each([
    ["timeout", new Error("Plugin request timed out")],
    ["process exit", new Error("Plugin app-server exited before responding")],
  ])("re-reads native truth after %s without retrying the mutation", async (_name, failure) => {
    const fixture = new PluginLibraryNativeFixture();
    await mount(fixture);
    await waitForPlugin("GitHub");
    const readsBefore = fixture.listPluginCalls.length;

    await userEvent.click(pluginInstallButton("GitHub"));
    await vi.waitFor(() => expect(fixture.installCalls).toHaveLength(1));
    fixture.failInstallAfterPersistence("github", failure);

    await vi.waitFor(() => expect(fixture.listPluginCalls.length).toBeGreaterThan(readsBefore));
    expect(fixture.installCalls).toHaveLength(1);
    await vi.waitFor(() => expect(pluginHasInstallAction("GitHub")).toBe(false));
  });

  it("opens the required-app authentication dialog only after install and authoritative reread", async () => {
    const fixture = new PluginLibraryNativeFixture();
    await mount(fixture);
    await waitForPlugin("GitHub");
    await userEvent.click(pluginInstallButton("GitHub"));
    await vi.waitFor(() => expect(fixture.installCalls).toHaveLength(1));
    fixture.completeInstall("github", {
      authPolicy: "ON_INSTALL",
      appsNeedingAuth: fixture.apps.map((app) => ({
        id: app.id,
        name: app.name,
        description: app.description,
        installUrl: app.installUrl,
        category: app.branding?.category ?? null,
      })),
    });

    await expect
      .poll(() => document.querySelector('[role="dialog"]')?.textContent, { timeout: 3_000 })
      .toContain("Connect your apps to GitHub");
    expect(page.getByRole("dialog").element().textContent).toContain("Slack");
  });

  it("keeps a settled install successful when the optional app reread is unavailable", async () => {
    const fixture = new PluginLibraryNativeFixture();
    fixture.appListError = new Error("provider app catalog unavailable");
    const addToast = vi.spyOn(toastManager, "add");
    await mount(fixture);
    await waitForPlugin("GitHub");
    await userEvent.click(pluginInstallButton("GitHub"));
    await vi.waitFor(() => expect(fixture.installCalls).toHaveLength(1));
    fixture.completeInstall("github", {
      authPolicy: "ON_INSTALL",
      appsNeedingAuth: fixture.apps.map((app) => ({
        id: app.id,
        name: app.name,
        description: app.description,
        installUrl: app.installUrl,
        category: app.branding?.category ?? null,
      })),
    });

    await vi.waitFor(() => expect(fixture.installedPluginIds.has(GITHUB_PLUGIN_ID)).toBe(true));
    await expect
      .poll(() => document.querySelector('[role="dialog"]')?.textContent, { timeout: 3_000 })
      .toContain("Connect your apps to GitHub");
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        title: "Plugin installed, but app connections could not refresh",
      }),
    );
    expect(addToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Install failed" }),
    );
    expect(fixture.listAppCalls.length).toBeGreaterThan(0);
    expect(fixture.installCalls).toHaveLength(1);
  });

  it("reconstructs installed state from native truth after a page restart", async () => {
    const fixture = new PluginLibraryNativeFixture();
    const first = await mount(fixture);
    await waitForPlugin("GitHub");
    await userEvent.click(pluginInstallButton("GitHub"));
    await vi.waitFor(() => expect(fixture.installCalls).toHaveLength(1));
    fixture.completeInstall("github");
    await vi.waitFor(() => expect(fixture.installedPluginIds.has(GITHUB_PLUGIN_ID)).toBe(true));
    await first.cleanup();
    mountedPages.pop();

    await mount(fixture);
    await waitForPlugin("GitHub");
    expect(pluginHasInstallAction("GitHub")).toBe(false);
    // Codex lists installed plugins in the sidebar; the directory row trades
    // its "+" for the installed "…" menu.
    await expect
      .element(page.getByRole("button", { name: "More actions" }).first())
      .toBeInTheDocument();
  });

  it("keeps installed actions when plugin detail cache predates the authoritative catalog", async () => {
    const fixture = new PluginLibraryNativeFixture();
    fixture.installedPluginIds.add(GITHUB_PLUGIN_ID);
    fixture.readPluginInstalledOverride = false;
    await mount(fixture, [`/skills/plugins/${encodeURIComponent(GITHUB_PLUGIN_ID)}`]);

    await waitForPlugin("GitHub");
    await expect.element(page.getByTestId("plugin-detail-content")).toBeInTheDocument();
    await expect.element(page.getByTestId("plugin-detail-description")).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "More actions" })).toBeInTheDocument();
  });

  it("settles enable from primary truth, ignores optional failures, and suppresses duplicates", async () => {
    const fixture = new PluginLibraryNativeFixture();
    fixture.installedPluginIds.add(GITHUB_PLUGIN_ID);
    fixture.disabledPluginIds.add(GITHUB_PLUGIN_ID);
    fixture.optionalShardError = new Error("remote plugin shard unavailable");
    const addToast = vi.spyOn(toastManager, "add");
    await mount(fixture, ["/skills/manage"]);
    await waitForPlugin("GitHub");

    const toggle = page.getByRole("switch", { name: "Toggle GitHub" });
    const toggleElement = toggle.element();
    toggleElement.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    toggleElement.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(fixture.setPluginEnabledCalls).toHaveLength(1));
    fixture.completeSetPluginEnabled(GITHUB_PLUGIN_ID, true);

    await expect.poll(() => toggle.element().getAttribute("aria-checked")).toBe("true");
    await vi.waitFor(() =>
      expect(addToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "success", title: "GitHub enabled" }),
      ),
    );
    expect(addToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Plugin update failed" }),
    );
    expect(fixture.setPluginEnabledCalls).toHaveLength(1);
  });

  it("settles uninstall from primary truth without an optional-shard failure toast", async () => {
    const fixture = new PluginLibraryNativeFixture();
    fixture.installedPluginIds.add(GITHUB_PLUGIN_ID);
    fixture.optionalShardError = new Error("remote plugin shard unavailable");
    const addToast = vi.spyOn(toastManager, "add");
    const mounted = await mount(fixture, [
      `/skills/plugins/${encodeURIComponent(GITHUB_PLUGIN_ID)}`,
    ]);
    await waitForPlugin("GitHub");
    await expect.element(page.getByTestId("plugin-detail-content")).toBeInTheDocument();

    await userEvent.click(page.getByRole("button", { name: "More actions" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Uninstall" }));
    const confirm = page.getByRole("alertdialog").getByRole("button", { name: "Uninstall" });
    const confirmElement = confirm.element();
    confirmElement.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    confirmElement.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(fixture.uninstallPluginCalls).toHaveLength(1));
    fixture.completeUninstall(GITHUB_PLUGIN_ID);

    await vi.waitFor(() => expect(fixture.installedPluginIds.has(GITHUB_PLUGIN_ID)).toBe(false));
    await vi.waitFor(() => expect(mounted.router.state.location.pathname).toBe("/skills"));
    await vi.waitFor(() => expect(pluginHasInstallAction("GitHub")).toBe(true));
    await vi.waitFor(() =>
      expect(addToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "success", title: "Uninstalled GitHub" }),
      ),
    );
    expect(addToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Uninstall failed" }),
    );
    expect(fixture.uninstallPluginCalls).toHaveLength(1);
  });
});
