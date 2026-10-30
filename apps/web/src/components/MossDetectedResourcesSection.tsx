// FILE: MossDetectedResourcesSection.tsx
// Purpose: Customize › Skills "On this computer": the skills and MCP servers the
//          user's own CLIs (Codex, Claude, ~/.agents, Cursor, Gemini, Grok,
//          OpenCode, Pi) already have, grouped by name across CLIs. Adopting one
//          imports it into the workspace's canonical `.moss` source through the
//          reversible resource-import plan, and the projection then hands it
//          to every agent — the user never configures it per CLI again.
// Layer: Web destination content (inside PluginLibrary's Skills tab)
// Exports: MossDetectedResourcesSection, groupDetectedResources

import type { MossResourceImportProvider, MossResourceImportResource } from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { McpIcon, PlusIcon, SkillCubeIcon } from "~/lib/icons";
import { useTranslation } from "~/localization";
import { ensureNativeApi } from "~/nativeApi";
import {
  PluginLibraryCardIconBox,
  PluginLibraryRow,
  PluginLibraryTwoColumnGrid,
} from "./PluginLibraryPrimitives";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";
import { toastManager } from "./ui/toast";

const PROVIDER_LABELS: Record<MossResourceImportProvider, string> = {
  codex: "Codex",
  claude: "Claude",
  agents: "Agents",
  cursor: "Cursor",
  gemini: "Gemini",
  grok: "Grok",
  opencode: "OpenCode",
  pi: "Pi",
};

export interface DetectedResourceGroup {
  readonly key: string;
  readonly kind: "skill" | "mcp";
  readonly name: string;
  readonly description: string;
  readonly providers: readonly string[];
  /** The copy Moss adopts: the first one found, workspace copies before user copies. */
  readonly source: MossResourceImportResource;
}

/** Collapses the same skill or MCP server found in several CLIs into one row. */
export function groupDetectedResources(
  resources: ReadonlyArray<MossResourceImportResource>,
): DetectedResourceGroup[] {
  const groups = new Map<string, { group: DetectedResourceGroup; providers: Set<string> }>();
  const ordered = resources.toSorted(
    (left, right) => (left.scope === "workspace" ? 0 : 1) - (right.scope === "workspace" ? 0 : 1),
  );
  for (const resource of ordered) {
    if (resource.kind === "plugin" || resource.quarantined) continue;
    const key = `${resource.kind}:${resource.name.toLowerCase()}`;
    const label = PROVIDER_LABELS[resource.provider];
    const existing = groups.get(key);
    if (existing) {
      existing.providers.add(label);
      continue;
    }
    groups.set(key, {
      providers: new Set([label]),
      group: {
        key,
        kind: resource.kind,
        name: resource.name,
        description: resource.description?.trim() ?? "",
        providers: [],
        source: resource,
      },
    });
  }
  const grouped: DetectedResourceGroup[] = [];
  for (const { group, providers } of groups.values()) {
    grouped.push(Object.assign(group, { providers: [...providers] }));
  }
  return grouped.toSorted((left, right) => left.name.localeCompare(right.name));
}

export function MossDetectedResourcesSection({
  cwd,
  search,
}: {
  readonly cwd: string | null;
  readonly search: string;
}) {
  const { t, format } = useTranslation();
  const queryClient = useQueryClient();
  const queryKey = ["mossResourceImport", "inventory", cwd] as const;
  const inventoryQuery = useQuery({
    queryKey,
    queryFn: () =>
      ensureNativeApi().provider.resourceImportInventory({
        cwd: cwd ?? "",
        kinds: ["skill", "mcp"],
      }),
    enabled: cwd !== null,
    staleTime: 30_000,
    retry: false,
  });

  const adopt = useMutation({
    mutationFn: async (group: DetectedResourceGroup) => {
      const api = ensureNativeApi().provider;
      const planned = await api.resourceImportPlan({
        cwd: cwd ?? "",
        resourceIds: [group.source.id],
        kinds: [group.kind],
      });
      const actionable = planned.plan.operations.some(
        (operation) =>
          operation.action === "copy" ||
          operation.action === "merge" ||
          operation.action === "replace",
      );
      if (!actionable) return { group, adopted: false };
      await api.resourceImportApply({ cwd: cwd ?? "", plan: planned.plan });
      return { group, adopted: true };
    },
    onSuccess: ({ group, adopted }) => {
      toastManager.add({
        type: "success",
        title: format(adopted ? "plugins.detected.adopted" : "plugins.detected.alreadyManaged", {
          name: group.name,
        }),
      });
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (cause, group) => {
      toastManager.add({
        type: "error",
        title: format("plugins.detected.failed", { name: group.name }),
        description: cause instanceof Error ? cause.message : String(cause),
      });
    },
  });

  const groups = useMemo(() => {
    const all = groupDetectedResources(inventoryQuery.data?.resources ?? []);
    const query = search.trim().toLowerCase();
    if (!query) return all;
    return all.filter(
      (group) =>
        group.name.toLowerCase().includes(query) || group.description.toLowerCase().includes(query),
    );
  }, [inventoryQuery.data, search]);

  // The section only adds value when something was found; failures stay quiet
  // because the CLI-scoped list below remains authoritative for each provider.
  if (cwd === null || groups.length === 0) return null;

  return (
    <section className="flex flex-col gap-3" data-testid="moss-detected-resources">
      <div className="flex flex-col gap-1 px-2">
        <h2 className="text-ui-lg font-medium text-foreground opacity-75">
          {t("plugins.detected.title")}
        </h2>
        <p className="text-ui-sm text-muted-foreground">{t("plugins.detected.subtitle")}</p>
      </div>
      <PluginLibraryTwoColumnGrid>
        {groups.map((group) => {
          const Icon = group.kind === "mcp" ? McpIcon : SkillCubeIcon;
          const busy = adopt.isPending && adopt.variables?.key === group.key;
          const label = format("plugins.detected.adopt", { name: group.name });
          return (
            <PluginLibraryRow
              key={group.key}
              domId={`moss-detected-${group.key}`}
              glyph={
                <PluginLibraryCardIconBox>
                  <Icon aria-hidden="true" className="size-5 text-muted-foreground" />
                </PluginLibraryCardIconBox>
              }
              title={group.name}
              description={
                group.description ||
                (group.kind === "mcp" ? t("plugins.detected.kind.mcp") : group.source.sourcePath)
              }
              onOpen={() => {
                if (!adopt.isPending) adopt.mutate(group);
              }}
              action={
                <span className="flex items-center gap-1.5">
                  {group.providers.map((provider) => (
                    <Badge key={provider} variant="secondary" className="text-ui-2xs font-medium">
                      {provider}
                    </Badge>
                  ))}
                  {busy ? (
                    <span className="inline-flex size-7 items-center justify-center" role="status">
                      <Spinner className="size-3.5 text-muted-foreground" />
                    </span>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={label}
                      title={label}
                      disabled={adopt.isPending}
                      onClick={(event) => {
                        event.stopPropagation();
                        adopt.mutate(group);
                      }}
                    >
                      <PlusIcon className="size-4" />
                    </Button>
                  )}
                </span>
              }
            />
          );
        })}
      </PluginLibraryTwoColumnGrid>
    </section>
  );
}
