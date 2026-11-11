// FILE: MossDetectedResourcesSection.tsx
// Purpose: Customize › Skills "On this computer": the skills and MCP servers the
//          user's own CLIs (Codex, Claude, ~/.agents, Cursor, Gemini, Grok,
//          OpenCode, Pi) already have, grouped by name across CLIs. Adopting one
//          imports it into the workspace's canonical `.moss` source through the
//          reversible resource-import plan, and the projection then hands it
//          to every agent — the user never configures it per CLI again.
//          Settings › Plugins lists, per tab, what can be brought in: Skills from
//          the user-level scan Settings › Import uses (no project needed; skills
//          land in Moss's own skills folder), MCP servers from the project import
//          above when a project is open. Only the Import buttons import.
//          Inventory is read-only; nothing is imported without a click.
// Layer: Web destination content (PluginLibrary's Skills tab, Settings › Plugins)
// Exports: MossDetectedResourcesSection, MossDetectedResourcesSettingsList,
//          groupDetectedResources, MossImportWorkspace

import type {
  MossResourceImportProvider,
  MossResourceImportResource,
  WorkspaceImportSourceKind,
} from "@moss/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useMemo, useState } from "react";

import { CheckIcon, McpIcon, PlusIcon, SkillCubeIcon } from "~/lib/icons";
import { useTranslation } from "~/localization";
import { ensureNativeApi } from "~/nativeApi";
import { workspaceImportCategoryCounts, workspaceImportSourceLabel } from "~/workspaceImportUi";
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

function isActionablePlan(plan: {
  readonly operations: ReadonlyArray<{ readonly action: string }>;
}): boolean {
  return plan.operations.some(
    (operation) =>
      operation.action === "copy" || operation.action === "merge" || operation.action === "replace",
  );
}

const EMPTY_KEYS: ReadonlySet<string> = new Set();

/**
 * A server-registered project the resource import may write into (`<cwd>/.moss`). The
 * server only accepts a registered project and needs its id, so a bare folder (the Home
 * chat folder, the server's own folder) is never a target.
 */
export interface MossImportWorkspace {
  readonly cwd: string;
  readonly workspaceId: string;
}

function useDetectedResources({
  workspace,
  search,
  kind,
}: {
  readonly workspace: MossImportWorkspace | null;
  readonly search: string;
  readonly kind?: "skill" | "mcp" | undefined;
}) {
  const { t, format } = useTranslation();
  const queryClient = useQueryClient();
  const cwd = workspace?.cwd ?? null;
  const target = workspace
    ? { cwd: workspace.cwd, workspaceId: workspace.workspaceId }
    : { cwd: "" };
  const queryKey = ["mossResourceImport", "inventory", cwd, workspace?.workspaceId] as const;
  const inventoryQuery = useQuery({
    queryKey,
    queryFn: () =>
      ensureNativeApi().provider.resourceImportInventory({
        ...target,
        kinds: ["skill", "mcp"],
      }),
    enabled: workspace !== null,
    staleTime: 30_000,
    retry: false,
  });

  // Rows imported in this visit (or found to be in Moss already), per import folder. The
  // inventory lists what each CLI has, so a row stays listed after it has been imported.
  const [importedByCwd, setImportedByCwd] = useState<ReadonlyMap<string, ReadonlySet<string>>>(
    () => new Map(),
  );
  const imported = importedByCwd.get(cwd ?? "") ?? EMPTY_KEYS;
  const markImported = (keys: ReadonlyArray<string>) =>
    setImportedByCwd((previous) => {
      const next = new Map(previous);
      next.set(cwd ?? "", new Set([...(previous.get(cwd ?? "") ?? []), ...keys]));
      return next;
    });

  const adopt = useMutation({
    mutationFn: async (group: DetectedResourceGroup) => {
      const api = ensureNativeApi().provider;
      const planned = await api.resourceImportPlan({
        ...target,
        resourceIds: [group.source.id],
        kinds: [group.kind],
      });
      if (!isActionablePlan(planned.plan)) return { group, adopted: false };
      await api.resourceImportApply({ ...target, plan: planned.plan });
      return { group, adopted: true };
    },
    onSuccess: ({ group, adopted }) => {
      markImported([group.key]);
      toastManager.add({
        type: "success",
        title: format(adopted ? "plugins.detected.adopted" : "plugins.detected.alreadyManaged", {
          name: group.name,
        }),
      });
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (cause, group) => {
      // Never the raw import error (paths, plan ids): one plain line.
      console.warn("[moss] resource import failed", cause);
      toastManager.add({
        type: "error",
        title: format("plugins.detected.failed", { name: group.name }),
        description: t("plugins.detected.failedDescription"),
      });
    },
  });

  const groups = useMemo(() => {
    const all = groupDetectedResources(inventoryQuery.data?.resources ?? []).filter(
      (group) => kind === undefined || group.kind === kind,
    );
    const query = search.trim().toLowerCase();
    if (!query) return all;
    return all.filter(
      (group) =>
        group.name.toLowerCase().includes(query) || group.description.toLowerCase().includes(query),
    );
  }, [inventoryQuery.data, kind, search]);

  const importAll = useMutation({
    mutationFn: async (targets: ReadonlyArray<DetectedResourceGroup>) => {
      const api = ensureNativeApi().provider;
      const planned = await api.resourceImportPlan({
        ...target,
        resourceIds: targets.map((group) => group.source.id),
        kinds: [...new Set(targets.map((group) => group.kind))],
      });
      if (isActionablePlan(planned.plan)) {
        await api.resourceImportApply({ ...target, plan: planned.plan });
      }
      return targets;
    },
    onSuccess: (targets) => {
      markImported(targets.map((group) => group.key));
      toastManager.add({
        type: "success",
        title: format("plugins.detected.importedAll", { count: targets.length }),
      });
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (cause) => {
      console.warn("[moss] resource import failed", cause);
      toastManager.add({
        type: "error",
        title: t("plugins.detected.importAllFailed"),
        description: t("plugins.detected.failedDescription"),
      });
    },
  });

  return { groups, adopt, importAll, imported };
}

export function MossDetectedResourcesSection({
  workspace,
  search,
}: {
  readonly workspace: MossImportWorkspace | null;
  readonly search: string;
}) {
  const { t, format } = useTranslation();
  const { groups, adopt } = useDetectedResources({ workspace, search });

  // The section only adds value when something was found; failures stay quiet
  // because the CLI-scoped list below remains authoritative for each provider.
  if (workspace === null || groups.length === 0) return null;

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
                      <Spinner className="size-4 text-muted-foreground" />
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

function SettingsListHeader({
  kind,
  subtitle,
  action,
}: {
  readonly kind: "skill" | "mcp";
  readonly subtitle: string;
  readonly action?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-end justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h3 className="text-ui-lg font-medium text-foreground">
          {t(
            kind === "mcp"
              ? "plugins.detected.settingsTitle.mcp"
              : "plugins.detected.settingsTitle.skills",
          )}
        </h3>
        <p className="truncate text-ui-sm text-muted-foreground">{subtitle}</p>
      </div>
      {action}
    </div>
  );
}

function SettingsListRow({
  kind,
  title,
  subtitle,
  badges,
  done,
  busy,
  disabled,
  importLabel,
  onImport,
}: {
  readonly kind: "skill" | "mcp";
  readonly title: string;
  readonly subtitle: string;
  readonly badges?: readonly string[];
  readonly done: boolean;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly importLabel: string;
  readonly onImport: () => void;
}) {
  const { t } = useTranslation();
  const Icon = kind === "mcp" ? McpIcon : SkillCubeIcon;
  return (
    <div
      data-testid="moss-detected-settings-row"
      className="flex items-center justify-between gap-3 px-3 py-3"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-control border border-border/60 text-muted-foreground">
          <Icon aria-hidden="true" className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui font-medium text-foreground">{title}</span>
          <span className="block truncate text-ui-sm text-muted-foreground">{subtitle}</span>
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {(badges ?? []).map((badge) => (
          <Badge key={badge} variant="secondary" className="text-ui-2xs font-medium">
            {badge}
          </Badge>
        ))}
        {done ? (
          <span className="inline-flex h-6 items-center gap-1 px-2 text-ui-sm text-muted-foreground">
            <CheckIcon aria-hidden="true" className="size-3.5" />
            {t("plugins.detected.imported")}
          </span>
        ) : (
          <Button
            variant="outline"
            size="xs"
            aria-label={importLabel}
            disabled={disabled}
            onClick={onImport}
          >
            {busy ? <Spinner className="size-3.5" /> : null}
            {t("plugins.detected.import")}
          </Button>
        )}
      </div>
    </div>
  );
}

const SETTINGS_LIST_CLASS_NAME =
  "flex flex-col divide-y divide-border/60 overflow-hidden rounded-card border border-border/70";

interface DetectedSkillSource {
  readonly source: WorkspaceImportSourceKind;
  readonly label: string;
  readonly count: number;
}

/**
 * Settings › Plugins › Skills: the skills the user's other AI apps have, one row per app,
 * from the same user-level scan Settings › Import runs. Importing copies them into Moss's
 * own skills folder, which every agent reads; no project is involved.
 */
function DetectedSkillSourcesList({
  search,
  onImported,
}: {
  readonly search: string;
  readonly onImported?: (() => void) | undefined;
}) {
  const { t, format } = useTranslation();
  const queryClient = useQueryClient();
  const queryKey = ["workspaceImport", "probe", "tools"] as const;
  const probeQuery = useQuery({
    queryKey,
    queryFn: () => ensureNativeApi().server.probeWorkspaceImport({ scope: "tools" }),
    staleTime: 30_000,
    retry: 1,
  });
  const [imported, setImported] = useState<ReadonlySet<WorkspaceImportSourceKind>>(() => new Set());
  const sources = useMemo<DetectedSkillSource[]>(() => {
    const query = search.trim().toLowerCase();
    return (probeQuery.data?.sources ?? [])
      .filter((preview) => preview.present)
      .map((preview) => ({
        source: preview.source,
        label: preview.displayName ?? workspaceImportSourceLabel(preview.source),
        count: workspaceImportCategoryCounts(preview).skills,
      }))
      .filter((entry) => entry.count > 0)
      .filter((entry) => !query || entry.label.toLowerCase().includes(query));
  }, [probeQuery.data, search]);

  const importSkills = useMutation({
    mutationFn: async (targets: ReadonlyArray<DetectedSkillSource>) => {
      const result = await ensureNativeApi().server.applyWorkspaceImport({
        sources: targets.map((target) => target.source),
        categories: ["skills"],
      });
      return { targets, result };
    },
    onSuccess: ({ targets, result }) => {
      setImported((previous) => new Set([...previous, ...targets.map((target) => target.source)]));
      const added = result.skills.filter(
        (skill) => skill.action === "copied" || skill.action === "updated",
      ).length;
      toastManager.add({
        type: "success",
        title:
          added > 0
            ? format("plugins.detected.importedSkills", { count: added })
            : t("plugins.detected.skillsUpToDate"),
      });
      void queryClient.invalidateQueries({ queryKey });
      onImported?.();
    },
    onError: (cause) => {
      // Never the raw import error (paths, method names): one plain line.
      console.warn("[moss] skill import failed", cause);
      toastManager.add({
        type: "error",
        title: t("plugins.detected.importAllFailed"),
        description: t("plugins.detected.failedDescription"),
      });
    },
  });

  if (sources.length === 0) return null;
  const pending = sources.filter((entry) => !imported.has(entry.source));
  const pendingCount = pending.reduce((total, entry) => total + entry.count, 0);
  return (
    <section
      className="flex flex-col gap-3"
      data-testid="moss-detected-settings-skill"
      aria-label={t("plugins.detected.settingsTitle.skills")}
    >
      <SettingsListHeader
        kind="skill"
        subtitle={t("plugins.detected.skillsSubtitle")}
        action={
          pending.length > 1 ? (
            <Button
              variant="outline"
              size="xs"
              className="shrink-0"
              disabled={importSkills.isPending}
              onClick={() => importSkills.mutate(pending)}
            >
              {importSkills.isPending && importSkills.variables?.length === pending.length ? (
                <Spinner className="size-3.5" />
              ) : null}
              {format("plugins.detected.importAll", { count: pendingCount })}
            </Button>
          ) : null
        }
      />
      <div className={SETTINGS_LIST_CLASS_NAME}>
        {sources.map((entry) => (
          <SettingsListRow
            key={entry.source}
            kind="skill"
            title={entry.label}
            subtitle={format("plugins.detected.sourceSkillCount", { count: entry.count })}
            done={imported.has(entry.source)}
            busy={
              importSkills.isPending &&
              importSkills.variables?.some((target) => target.source === entry.source) === true
            }
            disabled={importSkills.isPending}
            importLabel={format("plugins.detected.importAria", { name: entry.label })}
            onImport={() => importSkills.mutate([entry])}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * Settings › Plugins › MCP: the MCP servers the user's other CLIs have, imported into the
 * open project's Moss setup so every agent there gets them. Moss keeps MCP servers per
 * project, so without one open the list says that in one line instead of hiding.
 */
function DetectedMcpServersList({
  workspace,
  search,
}: {
  readonly workspace: MossImportWorkspace | null;
  readonly search: string;
}) {
  const { t, format } = useTranslation();
  const { groups, adopt, importAll, imported } = useDetectedResources({
    workspace,
    search,
    kind: "mcp",
  });
  if (workspace === null) {
    return (
      <p
        data-testid="moss-detected-settings-mcp-needs-project"
        className="px-1 text-ui-sm text-muted-foreground"
      >
        {t("plugins.detected.mcpNeedsProject")}
      </p>
    );
  }
  if (groups.length === 0) return null;
  const pending = groups.filter((group) => !imported.has(group.key));
  const busy = adopt.isPending || importAll.isPending;
  return (
    <section
      className="flex flex-col gap-3"
      data-testid="moss-detected-settings-mcp"
      aria-label={t("plugins.detected.settingsTitle.mcp")}
    >
      <SettingsListHeader
        kind="mcp"
        subtitle={t("plugins.detected.settingsSubtitle")}
        action={
          pending.length > 1 ? (
            <Button
              variant="outline"
              size="xs"
              className="shrink-0"
              disabled={busy}
              onClick={() => importAll.mutate(pending)}
            >
              {importAll.isPending ? <Spinner className="size-3.5" /> : null}
              {format("plugins.detected.importAll", { count: pending.length })}
            </Button>
          ) : null
        }
      />
      <div className={SETTINGS_LIST_CLASS_NAME}>
        {groups.map((group) => (
          <SettingsListRow
            key={group.key}
            kind="mcp"
            title={group.name}
            subtitle={group.description || t("plugins.detected.kind.mcp")}
            badges={group.providers}
            done={imported.has(group.key)}
            busy={
              (adopt.isPending && adopt.variables?.key === group.key) ||
              (importAll.isPending && importAll.variables?.includes(group) === true)
            }
            disabled={busy}
            importLabel={format("plugins.detected.importAria", { name: group.name })}
            onImport={() => adopt.mutate(group)}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * Settings › Plugins › MCP / Skills: what the user's other AI apps already have, above the
 * tab's own list, each with an Import button (and Import all when there are several).
 */
export function MossDetectedResourcesSettingsList({
  workspace,
  search,
  kind,
  onImported,
}: {
  /** The open project, when there is one; only MCP servers need it. */
  readonly workspace: MossImportWorkspace | null;
  readonly search: string;
  readonly kind: "skill" | "mcp";
  /** Called after skills were imported, so the host can re-read its skills list. */
  readonly onImported?: (() => void) | undefined;
}) {
  return kind === "skill" ? (
    <DetectedSkillSourcesList search={search} onImported={onImported} />
  ) : (
    <DetectedMcpServersList workspace={workspace} search={search} />
  );
}
