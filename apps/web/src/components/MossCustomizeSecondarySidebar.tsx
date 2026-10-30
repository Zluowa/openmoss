// FILE: MossCustomizeSecondarySidebar.tsx
// Purpose: Codex Customize secondary rail (Helios shot 04): Plugins / Skills + Installed list.
//          Brand = Moss. Used beside PluginLibrary when /skills (or /plugins) is active.
// Layer: Web shell destination secondary

import { useNavigate, useRouterState } from "@tanstack/react-router";
import { createContext, useEffect, useMemo, useState } from "react";

import { PluginIcon, SearchIcon, SkillCubeIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import {
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
  SIDEBAR_SECTION_LABEL_CLASS_NAME,
} from "~/sidebarRowStyles";
import { SIDEBAR_PANEL_TITLE_CLASS_NAME } from "./SidebarPanelTitle";
import { useTranslation } from "~/localization";
import type { ReactNode } from "react";

export type MossCustomizeTab = "plugins" | "skills";

export type MossInstalledPluginRow = {
  readonly id: string;
  readonly name: string;
  readonly glyph: ReactNode;
  readonly onOpen: (trigger: HTMLButtonElement) => void;
};

/**
 * The Customize shell's "Installed" rail, for a plugin page or manage view
 * rendered below it (a deep link renders no directory to report the rows).
 */
export const MossCustomizeInstalledRowsContext = createContext<
  ((rows: readonly MossInstalledPluginRow[]) => void) | null
>(null);

/** Search is only actionable when a destination owns the search field. */
export function resolveCustomizeSearchAvailability(input: {
  readonly hasSearchTarget: boolean;
  readonly hasSearchHandler: boolean;
}): boolean {
  return input.hasSearchHandler || input.hasSearchTarget;
}

export interface MossCustomizeSecondarySidebarProps {
  readonly activeTab?: MossCustomizeTab;
  readonly installed?: readonly MossInstalledPluginRow[];
  readonly onSelectTab?: (tab: MossCustomizeTab) => void;
  /** Optional search action supplied by a destination/detail host. */
  readonly onSearch?: () => void;
  readonly className?: string;
}

export function MossCustomizeSecondarySidebar({
  activeTab: activeTabProp,
  installed = [],
  onSelectTab,
  onSearch,
  className,
}: MossCustomizeSecondarySidebarProps) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { t } = useTranslation();
  const activeTab: MossCustomizeTab = useMemo(() => {
    if (activeTabProp) return activeTabProp;
    if (pathname.includes("/skills/manage") || pathname.endsWith("/skills")) {
      // Default marketplace landing = Plugins tab (Codex shot 04)
      return "plugins";
    }
    return "plugins";
  }, [activeTabProp, pathname]);
  const [hasSearchTarget, setHasSearchTarget] = useState(false);

  useEffect(() => {
    if (onSearch) {
      setHasSearchTarget(true);
      return;
    }
    const updateSearchAvailability = () => {
      setHasSearchTarget(Boolean(document.getElementById("plugins-page-search")));
    };
    updateSearchAvailability();
    const frame = window.requestAnimationFrame(updateSearchAvailability);
    return () => window.cancelAnimationFrame(frame);
  }, [onSearch, pathname, activeTab]);

  const searchDisabled = !resolveCustomizeSearchAvailability({
    hasSearchTarget,
    hasSearchHandler: Boolean(onSearch),
  });

  const selectTab = (tab: MossCustomizeTab) => {
    onSelectTab?.(tab);
    // Every tab browses from the /skills root; detail routes return to it.
    void navigate({ to: "/skills" });
  };

  const tabs = [
    { id: "plugins", label: t("plugins.tabs.plugins"), Icon: PluginIcon },
    { id: "skills", label: t("plugins.tabs.skills"), Icon: SkillCubeIcon },
  ] as const satisfies ReadonlyArray<{ id: MossCustomizeTab; label: string; Icon: unknown }>;

  return (
    <aside
      data-moss-customize-secondary
      data-moss-customize-secondary-sidebar
      aria-label={t("plugins.customize.title")}
      className={cn(
        "flex h-svh w-70 shrink-0 flex-col border-r border-[color:var(--app-rail-inset-border,var(--border))] bg-[var(--app-rail-panel-background,var(--sidebar))] pt-[46px] text-foreground",
        className,
      )}
    >
      <div className="flex h-12 shrink-0 items-center justify-between px-4">
        <h2 className={SIDEBAR_PANEL_TITLE_CLASS_NAME}>{t("plugins.customize.title")}</h2>
        <button
          type="button"
          className={cn(
            "inline-flex size-7 items-center justify-center rounded-control text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
            SIDEBAR_ROW_HOVER_CLASS_NAME,
          )}
          aria-label={t("plugins.customize.searchAria")}
          title={t("plugins.customize.searchAria")}
          disabled={searchDisabled}
          onClick={() => {
            if (onSearch) {
              onSearch();
              return;
            }
            const search = document.getElementById("plugins-page-search");
            if (search instanceof HTMLInputElement) {
              search.focus();
              search.select();
            }
          }}
        >
          <SearchIcon className="size-4" />
        </button>
      </div>

      <nav aria-label={t("plugins.customize.title")} className="flex flex-col gap-0 px-2">
        {tabs.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            data-moss-customize-tab={id}
            data-state={activeTab === id ? "active" : "inactive"}
            aria-current={activeTab === id ? "page" : undefined}
            className={cn(
              "flex h-8 items-center gap-2 rounded-row px-3 py-0 text-ui transition-colors",
              activeTab === id
                ? cn(SIDEBAR_ROW_ACTIVE_CLASS_NAME, "font-medium")
                : cn(SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME),
            )}
            onClick={() => selectTab(id)}
          >
            <Icon className="size-4" />
            {label}
          </button>
        ))}
      </nav>

      <div className="mt-3 flex min-h-0 flex-1 flex-col px-2 pb-3">
        <div className={cn("px-3 pb-2", SIDEBAR_SECTION_LABEL_CLASS_NAME)}>
          {t("plugins.action.installed")}
        </div>
        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto" data-moss-customize-installed>
          {installed.length > 0 ? (
            installed.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-row px-3 py-2 text-left text-ui transition-colors",
                    SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
                    SIDEBAR_ROW_HOVER_CLASS_NAME,
                  )}
                  data-moss-installed-plugin={row.id}
                  data-moss-customize-installed-item={row.id}
                  onClick={(event) => row.onOpen(event.currentTarget)}
                >
                  <span
                    aria-hidden
                    className="inline-flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-row bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] text-ui-xs font-semibold text-muted-foreground"
                  >
                    {row.glyph}
                  </span>
                  <span className="min-w-0 truncate">{row.name}</span>
                </button>
              </li>
            ))
          ) : (
            <li className="px-3 py-2 text-ui-sm leading-5 text-muted-foreground">
              {/* Plugins and Skills share Codex's installed-plugins rail. */}
              {t("plugins.customize.emptyPlugins")}
            </li>
          )}
        </ul>
      </div>
    </aside>
  );
}
