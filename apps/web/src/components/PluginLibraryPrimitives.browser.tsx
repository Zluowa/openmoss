// FILE: PluginLibraryPrimitives.browser.tsx
// Purpose: Browser-level Codex parity checks for plugin page chrome, search, and grid breakpoints.
// Layer: Browser UI test

import "../index.css";
import "./PluginLibrary.css";

import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useState } from "react";

import {
  PluginLibraryCardIconBox,
  PluginLibraryDetailIconBox,
  PluginLibraryHeader,
  PluginLibraryOneLineDescription,
  PluginLibraryPillTabs,
  PluginLibrarySearchInput,
  PluginLibraryTwoColumnGrid,
  canShowPluginRequestAction,
} from "./PluginLibraryPrimitives";

describe("PluginLibraryHeader", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("exposes the frozen Codex plugin browse controls and only supported create actions", async () => {
    const onTabChange = vi.fn();
    const onManage = vi.fn();
    const onRefresh = vi.fn();
    const onCreatePlugin = vi.fn();
    const onImportPluginsAndSkills = vi.fn();
    const screen = await render(
      <PluginLibraryHeader
        mode="browse"
        selectedTab="plugins"
        onTabChange={onTabChange}
        onManage={onManage}
        onRefresh={onRefresh}
        onCreatePlugin={onCreatePlugin}
        onImportPluginsAndSkills={onImportPluginsAndSkills}
        onCreateSkill={vi.fn()}
        onAddMarketplace={vi.fn()}
        onRequestPlugin={vi.fn()}
        requestPluginGate={{ authMethod: "chatgpt", featureFlagEnabled: true }}
      />,
    );

    try {
      await expect
        .element(page.getByRole("tablist", { name: "Browse plugins or skills" }))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("tab", { name: "Plugins" }))
        .toHaveAttribute("aria-selected", "true");
      await page.getByRole("tab", { name: "Skills" }).click();
      expect(onTabChange).toHaveBeenCalledWith("skills");

      await page.getByRole("button", { name: "Refresh" }).click();
      await page.getByRole("button", { name: "Manage" }).click();
      expect(onRefresh).toHaveBeenCalledOnce();
      expect(onManage).toHaveBeenCalledOnce();
      // The click event never reaches the handler: it would end up in history state,
      // which the browser must structured-clone (a PointerEvent cannot be).
      expect(onManage).toHaveBeenCalledWith();

      await page.getByRole("button", { name: "Create" }).click();
      for (const label of [
        "Create plugin",
        "Import plugins, skills, and MCP",
        "Add marketplace",
        "Request a plugin",
      ]) {
        await expect.element(page.getByText(label, { exact: true })).toBeInTheDocument();
      }
      // Codex's Add menu order: Create plugin, Add a marketplace, then the
      // archive import (a host without a dedicated upload falls back to Import).
      const menuLabels = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(
        (item) => item.textContent?.trim(),
      );
      expect(menuLabels).toEqual([
        "Create plugin",
        "Add marketplace",
        "Import plugins, skills, and MCP",
        "Request a plugin",
      ]);
      for (const label of ["Create skill", "Record a skill"]) {
        await expect.element(page.getByText(label, { exact: true })).not.toBeInTheDocument();
      }
      await page.getByText("Create plugin", { exact: true }).click();
      expect(onCreatePlugin).toHaveBeenCalledOnce();

      await page.getByRole("button", { name: "Create" }).click();
      await page.getByText("Import plugins, skills, and MCP", { exact: true }).click();
      expect(onImportPluginsAndSkills).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it("gates Record a skill and Request a plugin exactly like the frozen bundle", async () => {
    expect(canShowPluginRequestAction({ authMethod: "chatgpt", featureFlagEnabled: true })).toBe(
      true,
    );
    expect(canShowPluginRequestAction({ authMethod: "chatgpt", featureFlagEnabled: false })).toBe(
      false,
    );
    expect(canShowPluginRequestAction({ authMethod: "api-key", featureFlagEnabled: true })).toBe(
      false,
    );
    const screen = await render(
      <PluginLibraryHeader
        mode="browse"
        selectedTab="skills"
        onTabChange={vi.fn()}
        onRefresh={vi.fn()}
        onCreatePlugin={vi.fn()}
        onCreateSkill={vi.fn()}
        onRecordSkill={vi.fn()}
        onAddMarketplace={vi.fn()}
      />,
    );

    try {
      await page.getByRole("button", { name: "Create" }).click();
      for (const label of ["Create skill", "Record a skill"]) {
        await expect.element(page.getByText(label, { exact: true })).toBeInTheDocument();
      }
      for (const label of ["Create plugin", "Add marketplace", "Request a plugin"]) {
        await expect.element(page.getByText(label, { exact: true })).not.toBeInTheDocument();
      }
    } finally {
      await screen.unmount();
    }
  });

  it("runs Create skill straight from Add on Skills, and hides Add while it is unavailable", async () => {
    const onCreateSkill = vi.fn();
    const screen = await render(
      <PluginLibraryHeader
        mode="browse"
        selectedTab="skills"
        onTabChange={vi.fn()}
        onRefresh={vi.fn()}
        onCreatePlugin={vi.fn()}
        onCreateSkill={onCreateSkill}
        onAddMarketplace={vi.fn()}
      />,
    );

    try {
      const add = page.getByTestId("plugin-library-add-menu");
      // The visible label stays the name; the action it runs is the tooltip.
      await expect.element(add).toHaveAccessibleName("Create");
      await expect.element(add).toHaveAttribute("title", "Create skill");
      expect(add.element().querySelector("svg")).toBeNull();
      await add.click();
      expect(onCreateSkill).toHaveBeenCalledOnce();
      expect(document.querySelector('[role="menu"]')).toBeNull();

      await screen.rerender(
        <PluginLibraryHeader
          mode="browse"
          selectedTab="skills"
          onTabChange={vi.fn()}
          onRefresh={vi.fn()}
          onCreatePlugin={vi.fn()}
        />,
      );
      await expect.element(page.getByTestId("plugin-library-add-menu")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  // Owner feedback 2026-11-10: Settings' Add also creates apps and skills, each in a new chat.
  it("offers Settings' Add menu: Create plugin, app and skill, Add marketplace, Add MCP server", async () => {
    const screen = await render(
      <PluginLibraryHeader
        mode="manage"
        selectedTab="plugins"
        onTabChange={vi.fn()}
        onRefresh={vi.fn()}
        onCreatePlugin={vi.fn()}
        onCreateApp={vi.fn()}
        offerAllCreators
        onCreateSkill={vi.fn()}
        onAddMarketplace={vi.fn()}
        onUploadPluginArchive={vi.fn()}
        onAddCustomMcpServer={vi.fn()}
      />,
    );

    try {
      await page.getByTestId("plugin-library-add-menu").click();
      const menuLabels = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(
        (item) => item.textContent?.trim(),
      );
      expect(menuLabels).toEqual([
        "Create plugin",
        "Create app",
        "Create skill",
        "Add marketplace",
        "Add MCP server",
      ]);
    } finally {
      await screen.unmount();
    }
  });

  it("implements roving browse-tab focus with arrows, Home, End, and a results panel link", async () => {
    function StatefulHeader() {
      const [selectedTab, setSelectedTab] = useState<"plugins" | "skills">("plugins");
      return (
        <PluginLibraryHeader
          mode="browse"
          selectedTab={selectedTab}
          onTabChange={setSelectedTab}
          onRefresh={vi.fn()}
        />
      );
    }

    const screen = await render(<StatefulHeader />);

    try {
      const plugins = page.getByRole("tab", { name: "Plugins" });
      const skills = page.getByRole("tab", { name: "Skills" });
      await expect.element(plugins).toHaveAttribute("tabindex", "0");
      await expect.element(skills).toHaveAttribute("tabindex", "-1");
      await expect.element(plugins).toHaveAttribute("aria-controls", "plugins-page-results");
      plugins.element().focus();

      await userEvent.keyboard("{ArrowRight}");
      expect(document.activeElement).toBe(skills.element());
      await expect.element(skills).toHaveAttribute("aria-selected", "true");
      await expect.element(plugins).toHaveAttribute("tabindex", "-1");

      await userEvent.keyboard("{Home}");
      expect(document.activeElement).toBe(plugins.element());
      await expect.element(plugins).toHaveAttribute("aria-selected", "true");

      await userEvent.keyboard("{End}");
      expect(document.activeElement).toBe(skills.element());
      await expect.element(skills).toHaveAttribute("aria-selected", "true");
    } finally {
      await screen.unmount();
    }
  });

  it("renders the manage breadcrumb for the selected plugin tab", async () => {
    const screen = await render(
      <PluginLibraryHeader
        mode="manage"
        selectedTab="plugins"
        onTabChange={vi.fn()}
        onExitManage={vi.fn()}
        onRefresh={vi.fn()}
        onCreatePlugin={vi.fn()}
        onCreateSkill={vi.fn()}
      />,
    );

    try {
      await expect.element(page.getByText("Plugins", { exact: true })).toBeInTheDocument();
      await expect.element(page.getByText("Manage", { exact: true })).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});

describe("frozen Codex geometry", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("unifies the 44px header, 36px card icon, 60px detail icon, and one-line clamp", async () => {
    const screen = await render(
      <div>
        <PluginLibraryHeader
          mode="browse"
          selectedTab="plugins"
          onTabChange={vi.fn()}
          onRefresh={vi.fn()}
          onAddMarketplace={vi.fn()}
        />
        <PluginLibraryCardIconBox>card</PluginLibraryCardIconBox>
        <PluginLibraryDetailIconBox>detail</PluginLibraryDetailIconBox>
        <PluginLibraryOneLineDescription>
          This description must never occupy a second row.
        </PluginLibraryOneLineDescription>
      </div>,
    );

    try {
      expect(
        page.getByTestId("plugin-library-header").element().getBoundingClientRect().height,
      ).toBe(44);
      const card = page.getByTestId("plugin-library-card-icon").element().getBoundingClientRect();
      expect([card.width, card.height]).toEqual([36, 36]);
      const detail = page
        .getByTestId("plugin-library-detail-icon")
        .element()
        .getBoundingClientRect();
      expect([detail.width, detail.height]).toEqual([60, 60]);
      expect(
        getComputedStyle(page.getByTestId("plugin-library-one-line").element()).webkitLineClamp,
      ).toBe("1");
    } finally {
      await screen.unmount();
    }
  });
});

describe("PluginLibrarySearchInput", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("focuses with Cmd/Ctrl+F and activates arrow-selected results with Enter", async () => {
    const onActivateResult = vi.fn();
    const screen = await render(
      <PluginLibrarySearchInput
        value=""
        placeholder="Search plugins"
        resultIds={["plugin-a", "plugin-b"]}
        onChange={vi.fn()}
        onActivateResult={onActivateResult}
      />,
    );

    try {
      const input = page.getByRole("combobox", { name: "Search plugins" });
      await expect.element(input).not.toHaveFocus();
      expect(
        input.element().closest("[data-slot=input-group]")?.getBoundingClientRect().height,
      ).toBe(32);
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true }));
      await expect.element(input).toHaveFocus();

      const inputElement = input.element();
      inputElement.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await expect.element(input).toHaveAttribute("aria-activedescendant", "plugin-a");
      inputElement.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await expect.element(input).toHaveAttribute("aria-activedescendant", "plugin-b");
      inputElement.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
      await expect.element(input).toHaveAttribute("aria-activedescendant", "plugin-a");
      inputElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(onActivateResult).toHaveBeenCalledWith("plugin-a");
    } finally {
      await screen.unmount();
    }
  });
});

describe("PluginLibraryTwoColumnGrid", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  for (const scenario of [
    { width: 580, columns: 1 },
    { width: 581, columns: 2 },
    { width: 728, columns: 2, columnWidth: 344 },
  ]) {
    it(`uses ${scenario.columns} column(s) at a ${scenario.width}px container`, async () => {
      const host = document.createElement("div");
      host.style.width = `${scenario.width}px`;
      document.body.append(host);
      const screen = await render(
        <PluginLibraryTwoColumnGrid>
          <div className="plugin-library-plugin-row">One</div>
          <div className="plugin-library-plugin-row">Two</div>
        </PluginLibraryTwoColumnGrid>,
        { container: host },
      );

      try {
        const grid = page.getByTestId("plugin-library-grid").element();
        const columns = getComputedStyle(grid).gridTemplateColumns.split(" ");
        expect(columns).toHaveLength(scenario.columns);
        if (scenario.columnWidth !== undefined) {
          expect(columns).toEqual([`${scenario.columnWidth}px`, `${scenario.columnWidth}px`]);
          expect(getComputedStyle(grid).columnGap).toBe("40px");
          expect(getComputedStyle(grid).rowGap).toBe("0px");
          expect(grid.firstElementChild?.getBoundingClientRect().height).toBe(68);
        }
      } finally {
        await screen.unmount();
        host.remove();
      }
    });
  }
});

describe("PluginLibraryPillTabs horizontal overflow", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("scrolls overflowing category pills cleanly with fade and scroll controls without clipping", async () => {
    const categories = [
      { id: "all", label: "全部" },
      { id: "official", label: "Moss 官方" },
      { id: "dev", label: "开发者工具" },
      { id: "business", label: "企业与运营" },
      { id: "collab", label: "协同办公" },
      { id: "productivity", label: "效率工具" },
      { id: "communication", label: "沟通协作" },
      { id: "design", label: "设计创意" },
      { id: "finance", label: "财务与法务" },
      { id: "security", label: "安全" },
    ];
    function OverflowHarness() {
      const [selected, setSelected] = useState("all");
      return (
        <div style={{ width: 420 }}>
          <PluginLibraryPillTabs
            ariaLabel="插件分类"
            testId="plugin-category-tabs"
            tabs={categories}
            selected={selected}
            onSelect={setSelected}
          />
        </div>
      );
    }
    const screen = await render(<OverflowHarness />);
    try {
      const tablist = page.getByTestId("plugin-category-tabs").element();
      expect(tablist.className).toContain("scroll-fade-x");
      expect(tablist.scrollWidth).toBeGreaterThan(tablist.clientWidth);

      const scrollRight = page.getByTestId("plugin-category-tabs-scroll-right");
      await expect.element(scrollRight).toBeVisible();
      await expect
        .element(page.getByTestId("plugin-category-tabs-scroll-left"))
        .not.toBeInTheDocument();

      // Selecting the last pill scrolls it cleanly into the visible viewport.
      await userEvent.click(page.getByRole("tab", { name: "安全" }));
      await vi.waitFor(() => {
        const lastTabRect = page
          .getByRole("tab", { name: "安全" })
          .element()
          .getBoundingClientRect();
        const stripRect = tablist.getBoundingClientRect();
        expect(lastTabRect.right).toBeLessThanOrEqual(stripRect.right + 1);
      });
      await expect.element(page.getByTestId("plugin-category-tabs-scroll-left")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});
