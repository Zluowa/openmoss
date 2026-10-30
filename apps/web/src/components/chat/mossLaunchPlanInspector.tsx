// FILE: mossLaunchPlanInspector.tsx
// Purpose: Render the redacted Moss launch plan for an active provider session.
// Layer: Web chat control-plane presentation helper
// Exports: launch plan hook, view model derivation, and internal inspector component

import {
  type MossConfigEntry,
  type MossConfigSource,
  type MossLaunchPlan,
  type MossLaunchPlanEnvironmentVariable,
  type ProviderGetLaunchPlanResult,
  type ThreadId,
} from "@synara/contracts";
import { useEffect, useMemo, useState } from "react";

import { readNativeApi } from "../../nativeApi";

export type MossLaunchPlanLoadStatus = "idle" | "loading" | "ready" | "missing" | "error";
type NativeProviderApi = NonNullable<ReturnType<typeof readNativeApi>>["provider"];

export interface UseMossLaunchPlanInput {
  threadId: ThreadId | null | undefined;
  enabled?: boolean | undefined;
  refreshKey?: unknown;
}

export interface UseMossLaunchPlanState {
  status: MossLaunchPlanLoadStatus;
  result: ProviderGetLaunchPlanResult | null;
  error: string | null;
}

export interface MossLaunchPlanInspectorProps {
  result?: ProviderGetLaunchPlanResult | null | undefined;
  launchPlan?: MossLaunchPlan | null | undefined;
  planHash?: string | null | undefined;
  threadId?: string | null | undefined;
  status?: MossLaunchPlanLoadStatus | undefined;
  error?: string | null | undefined;
}

export interface MossLaunchPlanInspectorModel {
  launchPlan: MossLaunchPlan | null;
  planHash: string | null;
  threadId: string | null;
  status: MossLaunchPlanLoadStatus;
  error: string | null;
  summaryRows: ReadonlyArray<InspectorRow>;
  environmentRows: ReadonlyArray<InspectorRow>;
  permissionRows: ReadonlyArray<InspectorRow>;
  configSourceRows: ReadonlyArray<InspectorRow>;
  mcpRows: ReadonlyArray<InspectorRow>;
  skillRows: ReadonlyArray<InspectorRow>;
  memoryRows: ReadonlyArray<InspectorRow>;
  hookRows: ReadonlyArray<InspectorRow>;
  toolRows: ReadonlyArray<InspectorRow>;
  projectionWarningRows: ReadonlyArray<InspectorRow>;
  providerStartOptionRows: ReadonlyArray<InspectorRow>;
}

export interface InspectorRow {
  label: string;
  value: string;
  valueParts?: ReadonlyArray<InspectorValuePart> | undefined;
  tone?: "default" | "muted" | "warning" | "danger" | undefined;
}

export interface InspectorValuePart {
  value: string;
  localize: boolean;
}

export function useMossLaunchPlan({
  threadId,
  enabled = true,
  refreshKey,
}: UseMossLaunchPlanInput): UseMossLaunchPlanState {
  const [state, setState] = useState<UseMossLaunchPlanState>({
    status: "idle",
    result: null,
    error: null,
  });

  useEffect(() => {
    if (!enabled || !threadId) {
      setState({ status: "idle", result: null, error: null });
      return;
    }

    const api = readNativeApi();
    const providerApi = api?.provider as
      | (NativeProviderApi & {
          getLaunchPlan?: (input: { threadId: ThreadId }) => Promise<ProviderGetLaunchPlanResult>;
        })
      | undefined;
    if (typeof providerApi?.getLaunchPlan !== "function") {
      setState({ status: "missing", result: null, error: null });
      return;
    }

    let cancelled = false;
    setState({ status: "loading", result: null, error: null });
    void providerApi
      .getLaunchPlan({ threadId })
      .then((result) => {
        if (cancelled) return;
        setState({
          status: result.launchPlan ? "ready" : "missing",
          result,
          error: null,
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setState({
          status: "error",
          result: null,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, refreshKey, threadId]);

  return state;
}

export function deriveMossLaunchPlanInspectorModel({
  result,
  launchPlan,
  planHash,
  threadId,
  status,
  error,
}: MossLaunchPlanInspectorProps): MossLaunchPlanInspectorModel {
  const resolvedPlan = launchPlan ?? result?.launchPlan ?? null;
  const resolvedHash = planHash ?? result?.planHash ?? resolvedPlan?.planHash ?? null;
  const resolvedThreadId = threadId ?? result?.threadId ?? resolvedPlan?.workspace.threadId ?? null;
  const resolvedStatus =
    status ?? (resolvedPlan ? "ready" : result || resolvedHash ? "missing" : "idle");

  return {
    launchPlan: resolvedPlan,
    planHash: resolvedHash,
    threadId: resolvedThreadId ? String(resolvedThreadId) : null,
    status: resolvedStatus,
    error: error ?? null,
    summaryRows: resolvedPlan
      ? [
          { label: "Provider", value: resolvedPlan.provider },
          { label: "Model", value: resolvedPlan.model ?? "not specified", tone: "muted" },
          { label: "CWD", value: resolvedPlan.workspace.cwd },
          { label: "Created", value: resolvedPlan.createdAt },
          { label: "Plan ID", value: resolvedPlan.planId },
          { label: "Plan hash", value: resolvedPlan.planHash },
          {
            label: "Workspace thread",
            value: resolvedPlan.workspace.threadId
              ? String(resolvedPlan.workspace.threadId)
              : "not specified",
            tone: resolvedPlan.workspace.threadId ? "default" : "muted",
          },
          {
            label: "Project",
            value: resolvedPlan.workspace.projectId ?? "not specified",
            tone: resolvedPlan.workspace.projectId ? "default" : "muted",
          },
        ]
      : [],
    environmentRows: resolvedPlan ? rowsForEnvironment(resolvedPlan.environment.variables) : [],
    permissionRows: resolvedPlan
      ? [
          { label: "Runtime mode", value: resolvedPlan.permissions.runtimeMode },
          { label: "Approval policy", value: resolvedPlan.permissions.approvalPolicy },
          { label: "Sandbox mode", value: resolvedPlan.permissions.sandboxMode },
        ]
      : [],
    configSourceRows: resolvedPlan ? rowsForConfigSources(resolvedPlan.configSources) : [],
    mcpRows: resolvedPlan ? rowsForConfigEntries(resolvedPlan.mcp) : [],
    skillRows: resolvedPlan ? rowsForConfigEntries(resolvedPlan.skills) : [],
    memoryRows: resolvedPlan ? rowsForConfigEntries(resolvedPlan.memory) : [],
    hookRows: resolvedPlan ? rowsForConfigEntries(resolvedPlan.hooks) : [],
    toolRows: resolvedPlan
      ? [
          {
            label: "Allow",
            value: formatStringList(resolvedPlan.tools.allow, "none"),
            tone: resolvedPlan.tools.allow.length > 0 ? "default" : "muted",
          },
          {
            label: "Deny",
            value: formatStringList(resolvedPlan.tools.deny, "none"),
            tone: resolvedPlan.tools.deny.length > 0 ? "warning" : "muted",
          },
        ]
      : [],
    projectionWarningRows: resolvedPlan
      ? rowsForProjectionWarnings(resolvedPlan.projectionWarnings)
      : [],
    providerStartOptionRows: resolvedPlan
      ? rowsForProviderStartOptions(resolvedPlan.providerStartOptions)
      : [],
  };
}

export function MossLaunchPlanInspector(props: MossLaunchPlanInspectorProps) {
  const model = useMemo(() => deriveMossLaunchPlanInspectorModel(props), [props]);

  if (model.status === "loading") {
    return (
      <div className="px-3 py-2 text-ui-lg text-muted-foreground" data-moss-launch-plan-loading="">
        Loading launch plan
      </div>
    );
  }

  if (model.status === "error") {
    return (
      <div className="px-3 py-2 text-ui-lg text-destructive" data-moss-launch-plan-error="">
        Launch plan unavailable{model.error ? `: ${model.error}` : ""}
      </div>
    );
  }

  if (!model.launchPlan) {
    return (
      <div className="space-y-1 px-3 py-2 text-ui-lg" data-moss-launch-plan-missing="">
        <div className="font-medium text-foreground">No launch plan for this session</div>
        <div className="text-muted-foreground">
          {model.threadId ? `Thread ${model.threadId}` : "No active thread"}
          {model.planHash ? ` - hash ${model.planHash}` : ""}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 px-3 py-2 text-ui-lg" data-moss-launch-plan-inspector="">
      <header className="space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="font-medium text-foreground">Launch Plan</div>
          <code className="rounded border border-border/60 px-1.5 py-0.5 text-ui-sm text-muted-foreground">
            {model.planHash}
          </code>
        </div>
        <div className="text-ui-sm text-muted-foreground">
          {model.launchPlan.provider} / {model.launchPlan.model ?? "default model"}
        </div>
      </header>

      <InspectorSection title="Summary" rows={model.summaryRows} />
      <InspectorSection title="Permissions" rows={model.permissionRows} />
      <InspectorSection title="Environment" rows={model.environmentRows} />
      <InspectorSection title="Config Sources" rows={model.configSourceRows} />
      <InspectorSection title="MCP" rows={model.mcpRows} emptyLabel="No MCP servers" />
      <InspectorSection title="Skills" rows={model.skillRows} emptyLabel="No skills" />
      <InspectorSection title="Memory" rows={model.memoryRows} emptyLabel="No memory entries" />
      <InspectorSection title="Hooks" rows={model.hookRows} emptyLabel="No hooks" />
      <InspectorSection title="Tool Policy" rows={model.toolRows} />
      <InspectorSection
        title="Start Options"
        rows={model.providerStartOptionRows}
        emptyLabel="No provider start options"
      />
      <InspectorSection
        title="Projection Warnings"
        rows={model.projectionWarningRows}
        emptyLabel="No projection warnings"
      />
    </div>
  );
}

export function MossLaunchPlanInspectorForThread({
  threadId,
  enabled,
  refreshKey,
}: UseMossLaunchPlanInput) {
  const state = useMossLaunchPlan({ threadId, enabled, refreshKey });
  return (
    <MossLaunchPlanInspector
      result={state.result}
      threadId={threadId ? String(threadId) : null}
      status={state.status}
      error={state.error}
    />
  );
}

function InspectorSection({
  title,
  rows,
  emptyLabel = "None",
}: {
  title: string;
  rows: ReadonlyArray<InspectorRow>;
  emptyLabel?: string;
}) {
  return (
    <section className="space-y-1.5" data-moss-launch-plan-section={title}>
      <div className="text-ui-sm font-medium uppercase tracking-normal text-muted-foreground">
        {title}
      </div>
      {rows.length === 0 ? (
        <div className="text-ui-sm text-muted-foreground">{emptyLabel}</div>
      ) : (
        <dl className="divide-y divide-border/60 rounded-md border border-border/60">
          {rows.map((row) => (
            <div key={`${row.label}:${row.value}`} className="grid grid-cols-[9rem_1fr] gap-2 p-2">
              <dt className="min-w-0 break-words text-muted-foreground">{row.label}</dt>
              <dd className={valueClassName(row.tone)}>
                {row.valueParts
                  ? row.valueParts.map((part, index) => (
                      <span key={`${index}:${part.value}`}>
                        {index > 0 ? " / " : null}
                        <span {...(part.localize ? {} : { "data-localization-skip": "true" })}>
                          {part.value}
                        </span>
                      </span>
                    ))
                  : row.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function rowsForEnvironment(
  variables: ReadonlyArray<MossLaunchPlanEnvironmentVariable>,
): InspectorRow[] {
  if (variables.length === 0) {
    return [];
  }
  return variables.map((variable) => {
    const valueParts = [
      {
        value: variable.redacted ? "redacted" : "captured without value",
        localize: true,
      },
      variable.valueHash ? { value: `hash ${variable.valueHash}`, localize: true } : null,
      variable.source ? { value: `source ${variable.source}`, localize: true } : null,
    ].filter((part): part is InspectorValuePart => part !== null);
    return {
      label: variable.key,
      value: valueParts.map((part) => part.value).join(" / "),
      valueParts,
      tone: variable.redacted ? "warning" : "muted",
    };
  });
}

function rowsForConfigSources(sources: ReadonlyArray<MossConfigSource>): InspectorRow[] {
  return sources.map((source) => {
    const valueParts = [
      {
        value: source.path ?? "no path",
        localize: source.path === null || source.path === undefined,
      },
      source.required === true ? { value: "required", localize: true } : null,
      source.hash ? { value: `hash ${source.hash}`, localize: true } : null,
    ].filter((part): part is InspectorValuePart => part !== null);
    return {
      label: source.kind,
      value: valueParts.map((part) => part.value).join(" / "),
      valueParts,
      tone: source.required === true ? "default" : "muted",
    };
  });
}

function rowsForConfigEntries(entries: ReadonlyArray<MossConfigEntry>): InspectorRow[] {
  return entries.map((entry) => {
    const valueParts = [
      { value: entry.enabled === false ? "disabled" : "enabled", localize: true },
      entry.source ? { value: `source ${entry.source}`, localize: true } : null,
    ].filter((part): part is InspectorValuePart => part !== null);
    return {
      label: entry.name,
      value: valueParts.map((part) => part.value).join(" / "),
      valueParts,
      tone: entry.enabled === false ? "muted" : "default",
    };
  });
}

function rowsForProjectionWarnings(warnings: ReadonlyArray<string>): InspectorRow[] {
  return warnings.map((warning, index) => ({
    label: `Warning ${index + 1}`,
    value: warning,
    tone: "warning",
  }));
}

function rowsForProviderStartOptions(options: unknown): InspectorRow[] {
  const paths = summarizeObjectShape(options);
  return paths.map((path, index) => ({
    label: `Field ${index + 1}`,
    value: path,
    tone: "muted",
  }));
}

export function summarizeObjectShape(value: unknown): string[] {
  const rows: string[] = [];
  collectObjectShape(value, "", rows, 80);
  return rows;
}

function collectObjectShape(value: unknown, path: string, rows: string[], limit: number): void {
  if (rows.length >= limit || value === null || value === undefined) {
    return;
  }

  if (Array.isArray(value)) {
    if (path) {
      rows.push(`${path}[]`);
    }
    const first = value[0];
    if (first && typeof first === "object") {
      collectObjectShape(first, path ? `${path}[]` : "[]", rows, limit);
    }
    return;
  }

  if (typeof value !== "object") {
    if (path) {
      rows.push(path);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).toSorted();
  if (keys.length === 0) {
    if (path) {
      rows.push(path);
    }
    return;
  }

  for (const key of keys) {
    const nextPath = path ? `${path}.${key}` : key;
    const child = record[key];
    if (child && typeof child === "object") {
      collectObjectShape(child, nextPath, rows, limit);
    } else {
      rows.push(nextPath);
    }
    if (rows.length >= limit) {
      return;
    }
  }
}

function formatStringList(values: ReadonlyArray<string>, emptyLabel: string): string {
  return values.length > 0 ? values.join(", ") : emptyLabel;
}

function valueClassName(tone: InspectorRow["tone"]): string {
  switch (tone) {
    case "danger":
      return "min-w-0 break-words text-destructive";
    case "warning":
      return "min-w-0 break-words text-amber-600 dark:text-amber-300";
    case "muted":
      return "min-w-0 break-words text-muted-foreground";
    default:
      return "min-w-0 break-words text-foreground";
  }
}
