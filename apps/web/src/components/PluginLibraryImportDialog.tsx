// FILE: PluginLibraryImportDialog.tsx
// Purpose: Build6234 clean-room import flow for local plugin.json and SKILL.md
//          sources, including scan, conflict choice, preview, progress, result,
//          and a receipt-gated rollback action when the adapter supports CAS.
// Layer: Web UI

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { useTranslation } from "~/localization";
import {
  CircleCheckIcon,
  FileIcon,
  FolderOpenIcon,
  Loader2Icon,
  PluginIcon,
  TerminalIcon,
  TriangleAlertIcon,
  Undo2Icon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import {
  pluginImportErrorKey,
  resolvePluginImportAdapter,
  type PluginImportFallbackKey,
} from "~/lib/pluginImportError";
import {
  PLUGIN_IMPORT_MAX_BYTES,
  createPluginImportAdapter,
  inspectPluginImportConflict,
  isPluginImportAdapterError,
  isPluginImportDirectWriteError,
  parsePluginImportSource,
  type PluginImportCandidate,
  type PluginImportConflict,
  type PluginImportFileAdapter,
  type PluginImportResourceKind,
  type PluginImportWriteReceipt,
} from "~/lib/pluginImportAdapter";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

type PluginImportStage = "source" | "scan" | "conflict" | "preview" | "progress" | "result";
type PluginImportConflictChoice = "replace" | "skip";
type PluginImportResultStatus = "imported" | "skipped" | "failed";
type PluginImportTranslationKey = Parameters<ReturnType<typeof useTranslation>["t"]>[0];

interface PluginImportResult {
  readonly status: PluginImportResultStatus;
  readonly candidate: PluginImportCandidate;
  readonly canRollback: boolean;
  readonly writeReceipt: PluginImportWriteReceipt | null;
  readonly rolledBack: boolean;
  readonly rollbackError: string | null;
}

const IMPORT_STAGES: ReadonlyArray<{
  readonly id: PluginImportStage;
  readonly labelKey: PluginImportTranslationKey;
}> = [
  { id: "source", labelKey: "plugins.import.step.source" },
  { id: "scan", labelKey: "plugins.import.step.scan" },
  { id: "conflict", labelKey: "plugins.import.step.conflict" },
  { id: "preview", labelKey: "plugins.import.step.preview" },
  { id: "progress", labelKey: "plugins.import.step.progress" },
  { id: "result", labelKey: "plugins.import.step.result" },
];

export interface PluginLibraryImportDialogProps {
  readonly open: boolean;
  readonly cwd: string | null;
  readonly adapter?: PluginImportFileAdapter | undefined;
  readonly returnFocusRef?: RefObject<HTMLElement | null> | undefined;
  readonly onOpenChange: (open: boolean) => void;
  readonly onImported?: ((candidate: PluginImportCandidate) => void | Promise<void>) | undefined;
  /** The resource kind preselected when the dialog opens (the Add menu entry chosen). */
  readonly initialKind?: PluginImportResourceKind | undefined;
}

function importErrorMessage(
  error: unknown,
  t: ReturnType<typeof useTranslation>["t"],
  fallbackKey: PluginImportFallbackKey,
  kind?: PluginImportResourceKind,
): string {
  const key = pluginImportErrorKey(error, fallbackKey, kind);
  if (!isPluginImportAdapterError(error) && !isPluginImportDirectWriteError(error)) {
    console.error("[plugin-import] operation failed", error);
  }
  return t(key);
}

function importKindLabel(
  kind: PluginImportResourceKind,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (kind === "plugin") return t("plugins.import.kind.plugin");
  if (kind === "skill") return t("plugins.import.kind.skill");
  return t("plugins.import.kind.mcp");
}

function Stepper({
  stage,
  t,
}: {
  readonly stage: PluginImportStage;
  readonly t: ReturnType<typeof useTranslation>["t"];
}) {
  const currentIndex = IMPORT_STAGES.findIndex((item) => item.id === stage);
  return (
    <ol
      aria-label={t("plugins.import.stepsAria")}
      className="plugin-import-stepper grid grid-cols-3 gap-2 border-b border-border px-4 py-3 sm:grid-cols-6"
      data-testid="plugin-import-stepper"
    >
      {IMPORT_STAGES.map((item, index) => {
        const active = item.id === stage;
        const complete = index < currentIndex;
        return (
          <li
            key={item.id}
            aria-current={active ? "step" : undefined}
            className={cn(
              "flex min-w-0 items-center gap-1.5 text-ui-xs leading-4",
              active ? "font-medium text-foreground" : "text-muted-foreground",
            )}
            data-testid={`plugin-import-step-${item.id}`}
          >
            <span
              aria-hidden="true"
              className={cn(
                "inline-flex size-5 shrink-0 items-center justify-center rounded-full border text-ui-2xs",
                active && "border-foreground bg-foreground text-background",
                complete && !active && "border-foreground/50 text-foreground",
                !active && !complete && "border-border",
              )}
            >
              {complete ? "✓" : index + 1}
            </span>
            <span className="truncate">{t(item.labelKey)}</span>
          </li>
        );
      })}
    </ol>
  );
}

function StatusNotice({
  tone,
  testId,
  children,
}: {
  readonly tone: "warning" | "error" | "success" | "muted";
  readonly testId?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-xl border px-3 py-2.5 text-ui-lg leading-5",
        tone === "error" && "border-destructive/30 bg-destructive/8 text-destructive",
        tone === "warning" &&
          "border-amber-500/30 bg-amber-500/8 text-amber-700 dark:text-amber-300",
        tone === "success" &&
          "border-emerald-500/30 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300",
        tone === "muted" && "border-border bg-muted/30 text-muted-foreground",
      )}
      data-testid={testId}
      role={tone === "error" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}

export function PluginLibraryImportDialog({
  open,
  cwd,
  adapter,
  returnFocusRef,
  onOpenChange,
  onImported,
  initialKind = "plugin",
}: PluginLibraryImportDialogProps) {
  const { t, format } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<PluginImportStage>("source");
  const [kind, setKind] = useState<PluginImportResourceKind>(initialKind);
  const [source, setSource] = useState<{
    readonly sourceName: string;
    readonly contents: string;
  } | null>(null);
  const [candidate, setCandidate] = useState<PluginImportCandidate | null>(null);
  const [conflict, setConflict] = useState<PluginImportConflict | null>(null);
  const [conflictChoice, setConflictChoice] = useState<PluginImportConflictChoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [rollbackPending, setRollbackPending] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PluginImportResult | null>(null);

  const reset = useCallback(() => {
    setStage("source");
    setKind(initialKind);
    setSource(null);
    setCandidate(null);
    setConflict(null);
    setConflictChoice(null);
    setBusy(false);
    setRollbackPending(false);
    setProgress(0);
    setError(null);
    setResult(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [initialKind]);

  useEffect(() => {
    if (open) reset();
  }, [open, reset]);

  const resolveAdapter = useCallback(
    (): PluginImportFileAdapter | null => adapter ?? (cwd ? createPluginImportAdapter(cwd) : null),
    [adapter, cwd],
  );

  const scanSource = useCallback(
    async (nextSource: { readonly sourceName: string; readonly contents: string }) => {
      setSource(nextSource);
      setCandidate(null);
      setConflict(null);
      setResult(null);
      setError(null);
      setBusy(true);
      setProgress(0);
      setStage("scan");
      try {
        let parsed: ReturnType<typeof parsePluginImportSource>;
        try {
          parsed = parsePluginImportSource({ kind, ...nextSource });
        } catch (reason) {
          setError(importErrorMessage(reason, t, "plugins.import.scan.failed", kind));
          return;
        }
        if (!parsed.ok) {
          setError(t(parsed.errorKey));
          return;
        }
        setCandidate(parsed.candidate);
        setStage("conflict");
        const adapterResolution = resolvePluginImportAdapter(
          resolveAdapter,
          "plugins.import.read.failed",
          kind,
        );
        if (adapterResolution.errorKey) {
          setError(t(adapterResolution.errorKey));
          return;
        }
        const importAdapter = adapterResolution.adapter;
        if (!importAdapter) {
          setError(t("plugins.import.noWorkspace"));
          return;
        }
        try {
          const nextConflict = await inspectPluginImportConflict(importAdapter, parsed.candidate);
          setConflict(nextConflict);
          setConflictChoice(null);
        } catch (reason) {
          setError(importErrorMessage(reason, t, "plugins.import.read.failed", kind));
        }
      } finally {
        setBusy(false);
      }
    },
    [kind, resolveAdapter, t],
  );

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    if (file.size > PLUGIN_IMPORT_MAX_BYTES) {
      setStage("scan");
      setBusy(false);
      setError(t("plugins.import.source.tooLarge"));
      return;
    }
    void file
      .text()
      .then((contents) => scanSource({ sourceName: file.name, contents }))
      .catch((reason) => {
        setStage("scan");
        setBusy(false);
        setError(importErrorMessage(reason, t, "plugins.import.scan.failed", kind));
      });
  };

  const handleKindChange = (nextKind: PluginImportResourceKind) => {
    if (busy || rollbackPending) return;
    setKind(nextKind);
    setStage("source");
    setSource(null);
    setCandidate(null);
    setConflict(null);
    setResult(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const startImport = async () => {
    if (!candidate || !conflict || busy || rollbackPending) return;
    if (conflict.status === "existing" && conflictChoice === null) return;
    const adapterResolution = resolvePluginImportAdapter(
      resolveAdapter,
      "plugins.import.progress.failed",
      candidate.kind,
    );
    if (adapterResolution.errorKey) {
      const message = t(adapterResolution.errorKey);
      setError(message);
      setResult({
        status: "failed",
        candidate,
        canRollback: false,
        writeReceipt: null,
        rolledBack: false,
        rollbackError: null,
      });
      setStage("result");
      return;
    }
    const importAdapter = adapterResolution.adapter;
    if (!importAdapter) {
      setError(t("plugins.import.noWorkspace"));
      return;
    }

    setError(null);
    setStage("progress");
    setBusy(true);
    setProgress(12);
    try {
      if (conflict.status === "existing" && conflictChoice === "skip") {
        setProgress(100);
        setResult({
          status: "skipped",
          candidate,
          canRollback: false,
          writeReceipt: null,
          rolledBack: false,
          rollbackError: null,
        });
        setStage("result");
        return;
      }

      const writeReceipt = await importAdapter.apply({
        kind: candidate.kind,
        sourceName: candidate.sourceName,
        ...(candidate.sourceSelector ? { sourceSelector: candidate.sourceSelector } : {}),
        contents: candidate.contents,
        ...(conflict.status === "existing" && conflictChoice === "replace"
          ? { replaceExisting: true }
          : {}),
      });
      setProgress(100);
      setResult({
        status: "imported",
        candidate,
        canRollback: typeof importAdapter.rollback === "function",
        writeReceipt,
        rolledBack: false,
        rollbackError: null,
      });
      setStage("result");
      void Promise.resolve(onImported?.(candidate)).catch(() => undefined);
    } catch (reason) {
      setError(importErrorMessage(reason, t, "plugins.import.progress.failed", candidate.kind));
      setResult({
        status: "failed",
        candidate,
        canRollback: false,
        writeReceipt: null,
        rolledBack: false,
        rollbackError: null,
      });
      setStage("result");
    } finally {
      setBusy(false);
    }
  };

  const rollback = async () => {
    if (
      !candidate ||
      !result?.canRollback ||
      !result.writeReceipt ||
      result.rolledBack ||
      rollbackPending
    ) {
      return;
    }
    const writeReceipt = result.writeReceipt;
    const adapterResolution = resolvePluginImportAdapter(
      resolveAdapter,
      "plugins.import.rollback.failed",
    );
    if (adapterResolution.errorKey) {
      const message = t(adapterResolution.errorKey);
      setError(message);
      setResult((current) => (current ? { ...current, rollbackError: message } : current));
      return;
    }
    const importAdapter = adapterResolution.adapter;
    const rollbackWithReceipt = importAdapter?.rollback;
    if (!rollbackWithReceipt) return;
    setRollbackPending(true);
    setError(null);
    try {
      const rollbackResult = await rollbackWithReceipt({ receipt: writeReceipt });
      if (!rollbackResult.rolledBack) {
        throw new Error(t("plugins.import.rollback.notFound"));
      }
      setResult((current) =>
        current ? { ...current, rolledBack: true, rollbackError: null } : current,
      );
      void Promise.resolve(onImported?.(candidate)).catch(() => undefined);
    } catch (reason) {
      const message = importErrorMessage(reason, t, "plugins.import.rollback.failed");
      setError(message);
      setResult((current) => (current ? { ...current, rollbackError: message } : current));
    } finally {
      setRollbackPending(false);
    }
  };

  const close = () => {
    if (busy || rollbackPending) return;
    onOpenChange(false);
    const target = returnFocusRef?.current;
    if (target?.isConnected) {
      window.requestAnimationFrame(() => target.focus());
    }
  };

  const showSource = stage === "source";
  const showScan = stage === "scan";
  const showConflict = stage === "conflict";
  const showPreview = stage === "preview";
  const showProgress = stage === "progress";
  const showResult = stage === "result";

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => (nextOpen ? onOpenChange(true) : close())}>
      <DialogPopup
        surface="solid"
        className="plugin-library-import-dialog max-w-2xl"
        showCloseButton={!busy && !rollbackPending}
      >
        <DialogHeader>
          <DialogTitle data-testid="plugin-import-title">{t("plugins.import.title")}</DialogTitle>
          <DialogDescription>{t("plugins.import.subtitle")}</DialogDescription>
        </DialogHeader>

        <Stepper stage={stage} t={t} />

        <DialogPanel className="space-y-4" scrollFade={false}>
          {showSource ? (
            <div className="space-y-4" data-testid="plugin-import-source-panel">
              <fieldset className="space-y-2">
                <legend className="text-ui-lg font-medium text-foreground">
                  {t("plugins.import.source.kindLabel")}
                </legend>
                <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-3">
                  {(["plugin", "skill", "mcp"] as const).map((option) => (
                    <label
                      key={option}
                      htmlFor={`plugin-import-kind-${option}`}
                      data-testid={`plugin-import-kind-${option}`}
                      className={cn(
                        "flex min-h-16 min-w-0 cursor-pointer items-center gap-2 rounded-xl border px-3 text-left text-ui-lg transition-colors focus-within:ring-1 focus-within:ring-ring/60",
                        kind === option
                          ? "border-foreground bg-foreground/5 text-foreground"
                          : "border-border text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                      )}
                    >
                      <input
                        id={`plugin-import-kind-${option}`}
                        type="radio"
                        name="plugin-import-kind"
                        value={option}
                        checked={kind === option}
                        data-testid={`plugin-import-kind-${option}-input`}
                        disabled={busy || rollbackPending}
                        className="sr-only"
                        onChange={() => handleKindChange(option)}
                      />
                      {option === "plugin" ? (
                        <PluginIcon aria-hidden="true" className="size-4 shrink-0" />
                      ) : option === "mcp" ? (
                        <TerminalIcon aria-hidden="true" className="size-4 shrink-0" />
                      ) : (
                        <FileIcon aria-hidden="true" className="size-4 shrink-0" />
                      )}
                      <span className="min-w-0">
                        <span className="block font-medium">{importKindLabel(option, t)}</span>
                        <span className="block text-ui-sm text-muted-foreground">
                          {option === "plugin"
                            ? t("plugins.import.source.pluginHint")
                            : option === "skill"
                              ? t("plugins.import.source.skillHint")
                              : t("plugins.import.source.mcpHint")}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="rounded-xl border border-dashed border-border px-3 py-4">
                <input
                  ref={fileInputRef}
                  type="file"
                  className="sr-only"
                  accept={
                    kind === "plugin"
                      ? ".json,application/json"
                      : kind === "skill"
                        ? ".md,.markdown,text/markdown"
                        : ".json,.toml,application/json,application/toml"
                  }
                  aria-label={t("plugins.import.source.chooseFile")}
                  data-testid="plugin-import-source-file"
                  disabled={busy || rollbackPending}
                  onChange={handleFileChange}
                />
                <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-center gap-2">
                    <FolderOpenIcon className="size-5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="text-ui-lg font-medium text-foreground">
                        {source?.sourceName ?? t("plugins.import.source.noFile")}
                      </p>
                      <p className="text-ui-sm text-muted-foreground">
                        {source
                          ? t("plugins.import.source.ready")
                          : kind === "plugin"
                            ? t("plugins.import.source.pluginHint")
                            : kind === "skill"
                              ? t("plugins.import.source.skillHint")
                              : t("plugins.import.source.mcpHint")}
                      </p>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy || rollbackPending}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {t("plugins.import.source.chooseFile")}
                  </Button>
                </div>
              </div>

              {!cwd && !adapter ? (
                <StatusNotice tone="warning">
                  <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <span>{t("plugins.import.noWorkspace")}</span>
                </StatusNotice>
              ) : null}
              {error ? (
                <StatusNotice tone="error">
                  <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <span>{error}</span>
                </StatusNotice>
              ) : null}
            </div>
          ) : null}

          {showScan ? (
            <div className="space-y-4" data-testid="plugin-import-scan-panel">
              {busy ? (
                <StatusNotice tone="muted">
                  <Loader2Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 animate-spin" />
                  <span>{t("plugins.import.scan.loading")}</span>
                </StatusNotice>
              ) : error ? (
                <StatusNotice tone="error">
                  <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <span>{error}</span>
                </StatusNotice>
              ) : null}
            </div>
          ) : null}

          {showConflict ? (
            <div className="space-y-4" data-testid="plugin-import-conflict-panel">
              {busy ? (
                <StatusNotice tone="muted">
                  <Loader2Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 animate-spin" />
                  <span>{t("plugins.import.conflict.checking")}</span>
                </StatusNotice>
              ) : error ? (
                <StatusNotice tone="error">
                  <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <span>{error}</span>
                </StatusNotice>
              ) : conflict?.status === "missing" ? (
                <StatusNotice tone="success" testId="plugin-import-conflict-missing">
                  <CircleCheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <span>{t("plugins.import.conflict.none")}</span>
                </StatusNotice>
              ) : conflict?.status === "merge" ? (
                <StatusNotice tone="success" testId="plugin-import-conflict-merge">
                  <CircleCheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <span>{t("plugins.import.conflict.merge")}</span>
                </StatusNotice>
              ) : conflict?.status === "existing" ? (
                <div className="space-y-3">
                  <StatusNotice tone="warning" testId="plugin-import-conflict-existing">
                    <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                    <span>
                      {candidate?.kind === "mcp"
                        ? format("plugins.import.conflict.found", {
                            path: candidate.targetRelativePath,
                          })
                        : format("plugins.import.conflict.found", {
                            path: candidate?.targetRelativePath ?? "",
                          })}
                    </span>
                  </StatusNotice>
                  <fieldset className="space-y-2">
                    <legend className="text-ui-lg font-medium text-foreground">
                      {t("plugins.import.conflict.choiceLabel")}
                    </legend>
                    <label
                      className="flex cursor-pointer items-start gap-2 rounded-lg border border-border px-3 py-2.5 text-ui-lg"
                      data-testid="plugin-import-conflict-skip-option"
                    >
                      <input
                        type="radio"
                        data-testid="plugin-import-conflict-skip"
                        name="plugin-import-conflict-choice"
                        value="skip"
                        checked={conflictChoice === "skip"}
                        onChange={() => setConflictChoice("skip")}
                      />
                      <span>
                        <span className="block font-medium">
                          {t("plugins.import.conflict.skip")}
                        </span>
                        <span className="block text-ui-sm text-muted-foreground">
                          {t("plugins.import.conflict.skipHint")}
                        </span>
                      </span>
                    </label>
                    <label
                      className="flex cursor-pointer items-start gap-2 rounded-lg border border-border px-3 py-2.5 text-ui-lg"
                      data-testid="plugin-import-conflict-replace-option"
                    >
                      <input
                        type="radio"
                        data-testid="plugin-import-conflict-replace"
                        name="plugin-import-conflict-choice"
                        value="replace"
                        checked={conflictChoice === "replace"}
                        onChange={() => setConflictChoice("replace")}
                      />
                      <span>
                        <span className="block font-medium">
                          {candidate?.kind === "mcp"
                            ? t("plugins.import.conflict.mcpReplace")
                            : t("plugins.import.conflict.replace")}
                        </span>
                        <span className="block text-ui-sm text-muted-foreground">
                          {candidate?.kind === "mcp"
                            ? t("plugins.import.conflict.mcpReplaceHint")
                            : t("plugins.import.conflict.replaceHint")}
                        </span>
                      </span>
                    </label>
                  </fieldset>
                </div>
              ) : null}
            </div>
          ) : null}

          {showPreview && candidate && conflict ? (
            <div
              className="space-y-4"
              data-import-operation={
                conflict.status === "existing" && conflictChoice === "skip"
                  ? "skip"
                  : candidate.operation === "merge"
                    ? "merge"
                    : conflict.status === "existing"
                      ? "replace"
                      : "create"
              }
              data-testid="plugin-import-preview-panel"
            >
              <div className="grid gap-2 text-ui-lg sm:grid-cols-3">
                <div className="rounded-xl border border-border bg-muted/20 p-3">
                  <p className="text-ui-sm text-muted-foreground">
                    {t("plugins.import.preview.source")}
                  </p>
                  <p className="mt-1 truncate font-medium text-foreground">
                    {candidate.sourceName}
                  </p>
                </div>
                <div className="rounded-xl border border-border bg-muted/20 p-3">
                  <p className="text-ui-sm text-muted-foreground">
                    {t("plugins.import.preview.destination")}
                  </p>
                  <p className="mt-1 break-all font-medium text-foreground">
                    {candidate.targetRelativePath}
                  </p>
                </div>
                <div className="rounded-xl border border-border bg-muted/20 p-3">
                  <p className="text-ui-sm text-muted-foreground">
                    {t("plugins.import.preview.operation")}
                  </p>
                  <p className="mt-1 font-medium text-foreground">
                    {conflict.status === "existing" && conflictChoice === "skip"
                      ? t("plugins.import.operation.skip")
                      : candidate.operation === "merge"
                        ? t("plugins.import.operation.merge")
                        : conflict.status === "existing"
                          ? t("plugins.import.operation.replace")
                          : t("plugins.import.operation.create")}
                  </p>
                </div>
              </div>
              <div>
                <p className="mb-1 text-ui-sm font-medium uppercase tracking-wide text-muted-foreground">
                  {t(candidate.metadataLabelKey)}
                </p>
                <pre className="plugin-import-preview overflow-auto rounded-xl border border-border bg-muted/30 p-3 text-ui-sm leading-5 text-foreground">
                  {candidate.previewKey && candidate.previewValues
                    ? format(candidate.previewKey, candidate.previewValues)
                    : candidate.previewText}
                </pre>
              </div>
              <StatusNotice tone="muted">
                <span>{t("plugins.import.canonicalNotice")}</span>
              </StatusNotice>
              {candidate.kind === "mcp" ? (
                <StatusNotice tone="muted">
                  <span>{t("plugins.import.mcpPreview")}</span>
                </StatusNotice>
              ) : null}
            </div>
          ) : null}

          {showProgress && candidate ? (
            <div className="space-y-4" data-testid="plugin-import-progress-panel">
              <div className="flex items-center gap-2 text-ui-lg text-foreground">
                <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
                <span>{t("plugins.import.progress.writing")}</span>
              </div>
              <div
                aria-label={t("plugins.import.progress.aria")}
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={progress}
                className="h-2 overflow-hidden rounded-full bg-muted"
                role="progressbar"
              >
                <div
                  className="h-full rounded-full bg-foreground transition-[width] duration-200"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="truncate text-ui-sm text-muted-foreground">
                {candidate.targetRelativePath}
              </p>
            </div>
          ) : null}

          {showResult && result ? (
            <div
              className="space-y-4"
              data-import-status={result.status}
              data-testid="plugin-import-result-panel"
            >
              <StatusNotice
                testId="plugin-import-result-status"
                tone={
                  result.status === "imported"
                    ? "success"
                    : result.status === "failed"
                      ? "error"
                      : "muted"
                }
              >
                {result.status === "imported" ? (
                  <CircleCheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                ) : result.status === "failed" ? (
                  <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                ) : (
                  <FileIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                )}
                <span>
                  {result.status === "imported"
                    ? t("plugins.import.result.success")
                    : result.status === "skipped"
                      ? t("plugins.import.result.skipped")
                      : t("plugins.import.result.failed")}
                </span>
              </StatusNotice>
              {result.status === "imported" ? (
                <StatusNotice tone="muted">
                  <span>{t("plugins.import.canonicalNotice")}</span>
                </StatusNotice>
              ) : null}
              <div className="rounded-xl border border-border bg-muted/20 p-3 text-ui-lg">
                <p className="font-medium text-foreground">{result.candidate.name}</p>
                <code className="mt-1 block break-all text-ui-sm text-muted-foreground">
                  {result.candidate.targetRelativePath}
                </code>
              </div>
              {result.canRollback && !result.rolledBack ? (
                <StatusNotice tone="warning">
                  <Undo2Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <span className="min-w-0 flex-1">{t("plugins.import.rollback.prompt")}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="plugin-import-rollback"
                    disabled={rollbackPending}
                    onClick={() => void rollback()}
                  >
                    {rollbackPending
                      ? t("plugins.import.rollback.working")
                      : t("plugins.import.rollback.action")}
                  </Button>
                </StatusNotice>
              ) : null}
              {result.rolledBack ? (
                <StatusNotice tone="success" testId="plugin-import-rollback-done">
                  <CircleCheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <span>{t("plugins.import.rollback.done")}</span>
                </StatusNotice>
              ) : null}
              {result.rollbackError ? (
                <StatusNotice tone="error">
                  <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <span>{result.rollbackError}</span>
                </StatusNotice>
              ) : null}
              {error && result.status === "failed" ? (
                <StatusNotice tone="error">
                  <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <span>{error}</span>
                </StatusNotice>
              ) : null}
            </div>
          ) : null}
        </DialogPanel>

        <DialogFooter>
          {showSource ? (
            <>
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={close}>
                {t("plugins.action.cancel")}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!source || busy}
                onClick={() => source && void scanSource(source)}
              >
                {t("plugins.import.continue")}
              </Button>
            </>
          ) : null}
          {showScan ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setStage("source")}
              >
                {t("plugins.import.back")}
              </Button>
              {!busy && source ? (
                <Button type="button" size="sm" onClick={() => void scanSource(source)}>
                  {t("plugins.import.scan.retry")}
                </Button>
              ) : null}
            </>
          ) : null}
          {showConflict ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setStage("source")}
              >
                {t("plugins.import.back")}
              </Button>
              <Button
                type="button"
                size="sm"
                data-testid="plugin-import-review-preview"
                disabled={
                  !candidate ||
                  !conflict ||
                  busy ||
                  Boolean(error) ||
                  (conflict?.status === "existing" && conflictChoice === null)
                }
                onClick={() => setStage("preview")}
              >
                {t("plugins.import.preview.continue")}
              </Button>
            </>
          ) : null}
          {showPreview ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setStage("conflict")}
              >
                {t("plugins.import.back")}
              </Button>
              <Button
                type="button"
                size="sm"
                data-testid="plugin-import-confirm"
                disabled={busy}
                onClick={() => void startImport()}
              >
                {t("plugins.import.action")}
              </Button>
            </>
          ) : null}
          {showProgress ? (
            <Button type="button" size="sm" disabled aria-busy="true">
              {t("plugins.import.progress.writing")}
            </Button>
          ) : null}
          {showResult && result ? (
            <>
              {result.status === "failed" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setStage("source")}
                >
                  {t("plugins.import.retry")}
                </Button>
              ) : null}
              <Button type="button" size="sm" onClick={close}>
                {t("plugins.import.done")}
              </Button>
            </>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
