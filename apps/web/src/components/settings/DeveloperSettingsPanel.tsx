// FILE: DeveloperSettingsPanel.tsx
// Purpose: Google AI Studio / Build-style Settings panel for Personal Moss Developer API Keys,
//          isolated ¥3.00 trial credit balance, capability usage breakdown, and copyable SDK snippets.
// Layer: Settings UI components
// Exports: DeveloperSettingsPanel

import type {
  MossDeveloperApiKeyRecord,
  MossDeveloperCapability,
  MossDeveloperLedgerCapability,
  MossDeveloperLedgerEntry,
  MossDeveloperLedgerEventType,
} from "@moss/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import {
  serverMossDeveloperCreateKeyMutationOptions,
  serverMossDeveloperKeysQueryOptions,
  serverMossDeveloperRevokeKeyMutationOptions,
} from "~/components/auth/mossServerReactQuery";
import {
  SettingsCard,
  SettingsEmptyState,
  SettingsSectionShell,
} from "~/components/settings/SettingsPanelPrimitives";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { Tabs, type TabItem } from "~/components/ui/tabs";
import { toastManager } from "~/components/ui/toast";
import {
  CheckIcon,
  CircleAlertIcon,
  CopyIcon,
  PlusIcon,
  RotateCcwIcon,
  TrashCanIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation, type TranslationKey } from "~/localization";
import type { SettingsLocation } from "~/settingsLocation";

type SnippetLanguage = "curl" | "javascript";

const ALL_CAPABILITIES: readonly MossDeveloperCapability[] = ["llm", "image", "video", "voice"];

function formatNanoCny(nanoStr: string): string {
  try {
    const nano = BigInt(nanoStr);
    const negative = nano < 0n;
    const abs = negative ? -nano : nano;
    if (abs === 0n) return "¥0.00";
    const cny = Number(abs) / 1_000_000_000;
    const formatted =
      cny >= 0.01 ? cny.toFixed(2) : cny.toFixed(4).replace(/0+$/u, "").replace(/\.$/u, "");
    return `${negative ? "-" : ""}¥${formatted}`;
  } catch {
    return "¥0.00";
  }
}

function formatFen(fen: number): string {
  return `¥${(Math.max(0, fen) / 100).toFixed(2)}`;
}

function formatTimestamp(iso: string | null, neverLabel: string): string {
  if (!iso) return neverLabel;
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return neverLabel;
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return neverLabel;
  }
}

function capabilityLabelKey(capability: MossDeveloperLedgerCapability): TranslationKey {
  switch (capability) {
    case "grant":
      return "settings.developer.cap.grant";
    case "llm":
      return "settings.developer.cap.llm";
    case "image":
      return "settings.developer.cap.image";
    case "video":
      return "settings.developer.cap.video";
    case "voice":
      return "settings.developer.cap.voice";
  }
}

function ledgerEventLabelKey(eventType: MossDeveloperLedgerEventType): TranslationKey {
  switch (eventType) {
    case "initial_grant":
      return "settings.developer.ledger.event.initial_grant";
    case "reserve":
      return "settings.developer.ledger.event.reserve";
    case "capture":
      return "settings.developer.ledger.event.capture";
    case "release":
      return "settings.developer.ledger.event.release";
    case "debit":
      return "settings.developer.ledger.event.debit";
  }
}

export function buildDeveloperSnippet(input: {
  readonly capability: MossDeveloperCapability;
  readonly language: SnippetLanguage;
  readonly baseUrl: string;
  readonly apiKey: string;
}): string {
  const endpoint = input.baseUrl.replace(/\/+$/u, "");
  const key = input.apiKey || "moss_dk_cn_your_api_key";

  if (input.language === "curl") {
    switch (input.capability) {
      case "llm":
        return `curl -X POST "${endpoint}/chat/completions" \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "deepseek-v4-pro",
    "messages": [{ "role": "user", "content": "Hello Moss" }]
  }'`;
      case "image":
        return `curl -X POST "${endpoint}/images/generations" \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "grok-imagine-image-2.0",
    "prompt": "Minimalist isometric glass studio"
  }'`;
      case "video":
        return `curl -X POST "${endpoint}/videos/generations" \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "doubao-seedance-2.0-fast",
    "prompt": "Camera pans over misty pine forest",
    "duration": 5
  }'`;
      case "voice":
        return `# Speech synthesis (TTS) & transcription (STT) & Realtime Voice
curl -X POST "${endpoint}/audio/speech" \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-4o-mini-tts",
    "voice": "alloy",
    "input": "Hello from Moss Developer Voice API"
  }' --output speech.mp3

curl -X POST "${endpoint}/realtime/calls" \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{ "sessionId": "11111111-1111-4111-8111-111111111111", "voice": "alloy", "outputModality": "audio" }'`;
    }
  }

  switch (input.capability) {
    case "llm":
      return `const response = await fetch("${endpoint}/chat/completions", {
  method: "POST",
  headers: {
    "Authorization": "Bearer ${key}",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "deepseek-v4-pro",
    messages: [{ role: "user", content: "Hello Moss" }],
  }),
});
const data = await response.json();
console.log(data.choices?.[0]?.message?.content);`;
    case "image":
      return `const job = await fetch("${endpoint}/images/generations", {
  method: "POST",
  headers: {
    "Authorization": "Bearer ${key}",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "grok-imagine-image-2.0",
    prompt: "Minimalist isometric glass studio",
  }),
}).then((r) => r.json());
console.log(job.taskToken, job.status);`;
    case "video":
      return `const videoJob = await fetch("${endpoint}/videos/generations", {
  method: "POST",
  headers: {
    "Authorization": "Bearer ${key}",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "doubao-seedance-2.0-fast",
    prompt: "Camera pans over misty pine forest",
    duration: 5,
  }),
}).then((r) => r.json());
console.log(videoJob.taskToken, videoJob.status);`;
    case "voice":
      return `// Text-to-Speech (MP3 stream)
const audioBuffer = await fetch("${endpoint}/audio/speech", {
  method: "POST",
  headers: {
    "Authorization": "Bearer ${key}",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    input: "Hello from Moss Developer Voice API",
  }),
}).then((r) => r.arrayBuffer());

// Or start a Realtime Voice call
const session = await fetch("${endpoint}/realtime/calls", {
  method: "POST",
  headers: {
    "Authorization": "Bearer ${key}",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    sessionId: crypto.randomUUID(),
    voice: "alloy",
    outputModality: "audio",
  }),
}).then((r) => r.json());`;
  }
}

export function DeveloperSettingsPanel({
  onNavigate,
}: {
  readonly onNavigate?: (next: SettingsLocation) => void;
}) {
  const { t, format } = useTranslation();
  const queryClient = useQueryClient();
  const keysQuery = useQuery(serverMossDeveloperKeysQueryOptions());
  const createKeyMutation = useMutation(
    serverMossDeveloperCreateKeyMutationOptions({ queryClient }),
  );
  const revokeKeyMutation = useMutation(
    serverMossDeveloperRevokeKeyMutationOptions({ queryClient }),
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [selectedScopes, setSelectedScopes] =
    useState<readonly MossDeveloperCapability[]>(ALL_CAPABILITIES);
  const [revealedSecretKey, setRevealedSecretKey] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [pendingRevokeId, setPendingRevokeId] = useState<string | null>(null);
  const [snippetCapability, setSnippetCapability] = useState<MossDeveloperCapability>("llm");
  const [snippetLanguage, setSnippetLanguage] = useState<SnippetLanguage>("curl");

  const copyText = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => {
        setCopiedId((current) => (current === id ? null : current));
      }, 1_800);
    } catch {
      toastManager.add({ type: "error", title: t("settings.developer.copy") });
    }
  };

  const state = keysQuery.data;
  const activeGatewayBaseUrl =
    state?.localGatewayBaseUrl ??
    state?.gatewayBaseUrl ??
    "http://127.0.0.1:3773/api/moss/developer/v1";

  const capabilityTabs: ReadonlyArray<TabItem<MossDeveloperCapability>> = useMemo(
    () =>
      ALL_CAPABILITIES.map((cap) => ({
        id: cap,
        label: t(capabilityLabelKey(cap)),
      })),
    [t],
  );

  const languageTabs: ReadonlyArray<TabItem<SnippetLanguage>> = useMemo(
    () => [
      { id: "curl", label: "cURL" },
      { id: "javascript", label: "JavaScript" },
    ],
    [],
  );

  const snippet = useMemo(
    () =>
      buildDeveloperSnippet({
        capability: snippetCapability,
        language: snippetLanguage,
        baseUrl: activeGatewayBaseUrl,
        apiKey: revealedSecretKey ?? "moss_dk_cn_your_api_key",
      }),
    [activeGatewayBaseUrl, revealedSecretKey, snippetCapability, snippetLanguage],
  );

  const toggleScope = (cap: MossDeveloperCapability) => {
    setSelectedScopes((current) => {
      if (current.includes(cap)) {
        if (current.length === 1) return current;
        return current.filter((item) => item !== cap);
      }
      return [...current, cap];
    });
  };

  const handleCreateSubmit = async () => {
    const trimmed = newKeyName.trim();
    if (!trimmed) return;
    try {
      const created = await createKeyMutation.mutateAsync({
        name: trimmed,
        scopes: [...selectedScopes],
      });
      setRevealedSecretKey(created.secretKey);
      setCreateOpen(false);
      setNewKeyName("");
      setSelectedScopes(ALL_CAPABILITIES);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: error instanceof Error ? error.message : t("settings.developer.createModalTitle"),
      });
    }
  };

  const handleRevoke = async (keyRecord: MossDeveloperApiKeyRecord) => {
    if (pendingRevokeId !== keyRecord.id) {
      setPendingRevokeId(keyRecord.id);
      return;
    }
    try {
      await revokeKeyMutation.mutateAsync({ keyId: keyRecord.id });
      setPendingRevokeId(null);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: error instanceof Error ? error.message : t("settings.developer.revoke"),
      });
    }
  };

  if (keysQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Spinner />
      </div>
    );
  }

  if (keysQuery.isError) {
    return (
      <SettingsEmptyState layout="block" tone="destructive">
        <div className="flex flex-col items-center gap-3">
          <span>
            {keysQuery.error instanceof Error
              ? keysQuery.error.message
              : t("settings.developer.creditsTitle")}
          </span>
          <Button size="sm" variant="outline" onClick={() => void keysQuery.refetch()}>
            <RotateCcwIcon className="size-3.5" />
            {t("settings.developer.refresh")}
          </Button>
        </div>
      </SettingsEmptyState>
    );
  }

  if (!state?.authenticated) {
    return (
      <SettingsSectionShell title={t("settings.developer.creditsTitle")}>
        <SettingsCard>
          <div className="flex items-center justify-between gap-4 px-4 py-4">
            <div className="text-ui text-foreground">{t("settings.developer.signInHeading")}</div>
            {onNavigate ? (
              <Button size="sm" onClick={() => onNavigate({ section: "account" })}>
                {t("settings.developer.signInAction")}
              </Button>
            ) : null}
          </div>
        </SettingsCard>
      </SettingsSectionShell>
    );
  }

  const wallet = state.wallet;
  const availableFen = wallet?.availableFen ?? 0;
  const initialGrantFen = wallet?.initialGrantFen ?? 300;
  const spentFen = wallet?.spentFen ?? 0;
  const heldFen = wallet?.heldFen ?? 0;
  const remainingRatio =
    initialGrantFen > 0 ? Math.max(0, Math.min(100, (availableFen / initialGrantFen) * 100)) : 0;
  const isExhausted = availableFen <= 0;

  return (
    <div className="space-y-6">
      <SettingsSectionShell
        title={t("settings.developer.creditsTitle")}
        action={
          <Button
            size="xs"
            variant="ghost"
            disabled={keysQuery.isFetching}
            onClick={() => void keysQuery.refetch()}
          >
            <RotateCcwIcon className="size-3.5" />
            {t("settings.developer.refresh")}
          </Button>
        }
      >
        <SettingsCard divided={false} className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-caption text-muted-foreground">
                  {t("settings.developer.availableLabel")}
                </span>
                <span className="rounded-full border border-border px-2 py-0.5 text-caption text-muted-foreground">
                  {t("settings.developer.trialBadge")}
                </span>
              </div>
              <div
                data-testid="developer-balance-amount"
                className={cn(
                  "mt-1 text-2xl font-medium tabular-nums tracking-tight",
                  isExhausted ? "text-destructive" : "text-foreground",
                )}
              >
                {formatFen(availableFen)}
              </div>
            </div>
            <div className="flex items-center gap-5 text-caption text-muted-foreground tabular-nums">
              <div>
                <div>{t("settings.developer.initialGrantLabel")}</div>
                <div className="mt-0.5 font-medium text-foreground">
                  {formatFen(initialGrantFen)}
                </div>
              </div>
              <div>
                <div>{t("settings.developer.spentLabel")}</div>
                <div className="mt-0.5 font-medium text-foreground">{formatFen(spentFen)}</div>
              </div>
              <div>
                <div>{t("settings.developer.heldLabel")}</div>
                <div className="mt-0.5 font-medium text-foreground">{formatFen(heldFen)}</div>
              </div>
            </div>
          </div>

          <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-border/60">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                isExhausted ? "bg-destructive" : "bg-foreground",
              )}
              style={{ width: `${remainingRatio}%` }}
            />
          </div>

          {isExhausted ? (
            <div
              data-testid="developer-exhausted-alert"
              className="mt-4 flex items-center gap-2 rounded-control border border-destructive/30 bg-destructive/5 px-3 py-2 text-caption text-destructive"
            >
              <CircleAlertIcon className="size-4 shrink-0" />
              <span>{t("settings.developer.exhaustedAlert")}</span>
            </div>
          ) : null}

          <div className="mt-4 grid grid-cols-2 gap-2 border-t border-border/60 pt-4 sm:grid-cols-4">
            {ALL_CAPABILITIES.map((capability) => {
              const stats = state.breakdown.find((entry) => entry.capability === capability);
              return (
                <div key={capability} className="rounded-control border border-border/70 px-3 py-2">
                  <div className="text-caption text-muted-foreground">
                    {t(capabilityLabelKey(capability))}
                  </div>
                  <div className="mt-1 text-ui font-medium tabular-nums text-foreground">
                    {formatNanoCny(stats?.spentNanoCny ?? "0")}
                  </div>
                  <div className="text-caption text-muted-foreground tabular-nums">
                    {stats?.requestCount ?? 0} {t("settings.developer.requestsUnit")}
                  </div>
                </div>
              );
            })}
          </div>
        </SettingsCard>
      </SettingsSectionShell>

      <SettingsSectionShell
        title={t("settings.developer.keysHeading")}
        action={
          <Button
            size="sm"
            data-testid="developer-create-key-trigger"
            onClick={() => setCreateOpen(true)}
          >
            <PlusIcon className="size-3.5" />
            {t("settings.developer.createKey")}
          </Button>
        }
      >
        {revealedSecretKey ? (
          <SettingsCard divided={false} className="mb-3 border-primary/40 bg-primary/5 p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-caption font-medium text-foreground">
                {t("settings.developer.secretOnceWarning")}
              </div>
              <Button
                size="xs"
                variant="outline"
                data-testid="developer-copy-created-key"
                onClick={() => void copyText("revealed-secret", revealedSecretKey)}
              >
                {copiedId === "revealed-secret" ? (
                  <CheckIcon className="size-3.5" />
                ) : (
                  <CopyIcon className="size-3.5" />
                )}
                {copiedId === "revealed-secret"
                  ? t("settings.developer.copied")
                  : t("settings.developer.copy")}
              </Button>
            </div>
            <pre
              data-testid="developer-revealed-secret"
              className="mt-2 overflow-x-auto rounded-control border border-border/70 bg-background px-3 py-2 font-mono text-caption text-foreground select-all"
            >
              {revealedSecretKey}
            </pre>
          </SettingsCard>
        ) : null}

        {state.keys.length === 0 ? (
          <SettingsEmptyState layout="block">
            <span data-testid="developer-empty-keys">{t("settings.developer.noKeys")}</span>
          </SettingsEmptyState>
        ) : (
          <SettingsCard>
            {state.keys.map((keyItem) => {
              const isRevoked = keyItem.status === "revoked";
              const confirmingRevoke = pendingRevokeId === keyItem.id;
              return (
                <div
                  key={keyItem.id}
                  data-testid={`developer-key-row-${keyItem.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-ui font-medium text-foreground">{keyItem.name}</span>
                      <span
                        className={cn(
                          "rounded-full border px-2 py-0.5 text-caption",
                          isRevoked
                            ? "border-border text-muted-foreground"
                            : "border-primary/40 text-foreground",
                        )}
                      >
                        {isRevoked
                          ? t("settings.developer.statusRevoked")
                          : t("settings.developer.statusActive")}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 text-caption text-muted-foreground">
                      <code className="font-mono text-foreground">{keyItem.keyPrefix}••••</code>
                      <span>
                        {t("settings.developer.createdAt")}:{" "}
                        {formatTimestamp(keyItem.createdAt, t("settings.developer.neverUsed"))}
                      </span>
                      <span>
                        {t("settings.developer.lastUsedAt")}:{" "}
                        {formatTimestamp(keyItem.lastUsedAt, t("settings.developer.neverUsed"))}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1.5 pt-0.5">
                      {keyItem.scopes.map((scope) => (
                        <span
                          key={scope}
                          className="rounded-control border border-border/70 px-1.5 py-0.5 text-caption text-muted-foreground"
                        >
                          {t(capabilityLabelKey(scope))}
                        </span>
                      ))}
                    </div>
                  </div>
                  {!isRevoked ? (
                    <div className="flex items-center gap-2">
                      {confirmingRevoke ? (
                        <Button size="xs" variant="ghost" onClick={() => setPendingRevokeId(null)}>
                          {t("settings.developer.cancel")}
                        </Button>
                      ) : null}
                      <Button
                        size="xs"
                        variant={confirmingRevoke ? "destructive" : "outline"}
                        disabled={revokeKeyMutation.isPending}
                        data-testid={`developer-revoke-key-${keyItem.id}`}
                        onClick={() => void handleRevoke(keyItem)}
                      >
                        <TrashCanIcon className="size-3.5" />
                        {confirmingRevoke
                          ? t("settings.developer.revokeConfirm")
                          : t("settings.developer.revoke")}
                      </Button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </SettingsCard>
        )}
      </SettingsSectionShell>

      <SettingsSectionShell title={t("settings.developer.endpointsHeading")}>
        <SettingsCard>
          {state.localGatewayBaseUrl ? (
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="text-caption text-muted-foreground">
                  {t("settings.developer.localGatewayLabel")}
                </div>
                <code className="block truncate font-mono text-caption text-foreground">
                  {state.localGatewayBaseUrl}
                </code>
              </div>
              <Button
                size="xs"
                variant="outline"
                onClick={() => void copyText("local-endpoint", state.localGatewayBaseUrl!)}
              >
                {copiedId === "local-endpoint" ? (
                  <CheckIcon className="size-3.5" />
                ) : (
                  <CopyIcon className="size-3.5" />
                )}
                {copiedId === "local-endpoint"
                  ? t("settings.developer.copied")
                  : t("settings.developer.copy")}
              </Button>
            </div>
          ) : null}
          {state.gatewayBaseUrl ? (
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="text-caption text-muted-foreground">
                  {t("settings.developer.cloudGatewayLabel")}
                </div>
                <code className="block truncate font-mono text-caption text-foreground">
                  {state.gatewayBaseUrl}
                </code>
              </div>
              <Button
                size="xs"
                variant="outline"
                onClick={() => void copyText("cloud-endpoint", state.gatewayBaseUrl!)}
              >
                {copiedId === "cloud-endpoint" ? (
                  <CheckIcon className="size-3.5" />
                ) : (
                  <CopyIcon className="size-3.5" />
                )}
                {copiedId === "cloud-endpoint"
                  ? t("settings.developer.copied")
                  : t("settings.developer.copy")}
              </Button>
            </div>
          ) : null}
        </SettingsCard>
      </SettingsSectionShell>

      <SettingsSectionShell title={t("settings.developer.snippetsHeading")}>
        <SettingsCard divided={false} className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Tabs
              ariaLabel={t("settings.developer.snippetsHeading")}
              tabs={capabilityTabs}
              selected={snippetCapability}
              onSelect={setSnippetCapability}
              variant="segmented"
              testId="developer-snippet-capability-tabs"
            />
            <Tabs
              ariaLabel={t("settings.developer.codeFormatAria")}
              tabs={languageTabs}
              selected={snippetLanguage}
              onSelect={setSnippetLanguage}
              variant="segmented"
              testId="developer-snippet-language-tabs"
            />
          </div>
          <div className="relative">
            <div className="mb-2 flex justify-end">
              <Button
                size="xs"
                variant="outline"
                data-testid="developer-copy-snippet"
                onClick={() => void copyText("snippet", snippet)}
              >
                {copiedId === "snippet" ? (
                  <CheckIcon className="size-3.5" />
                ) : (
                  <CopyIcon className="size-3.5" />
                )}
                {copiedId === "snippet"
                  ? t("settings.developer.copied")
                  : t("settings.developer.copy")}
              </Button>
            </div>
            <pre
              data-testid="developer-snippet-code"
              className="overflow-x-auto rounded-control border border-border/70 bg-muted/40 p-3 font-mono text-caption leading-relaxed text-foreground"
            >
              <code>{snippet}</code>
            </pre>
          </div>
        </SettingsCard>
      </SettingsSectionShell>

      <SettingsSectionShell title={t("settings.developer.ledgerHeading")}>
        {state.recentLedger.length === 0 ? (
          <SettingsEmptyState layout="status">
            {t("settings.developer.noLedger")}
          </SettingsEmptyState>
        ) : (
          <SettingsCard>
            {state.recentLedger.slice(0, 8).map((entry: MossDeveloperLedgerEntry) => (
              <div
                key={entry.id}
                data-testid={`developer-ledger-row-${entry.id}`}
                className="flex items-center justify-between gap-3 px-4 py-2.5 text-caption"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 font-medium text-foreground">
                    <span>{t(ledgerEventLabelKey(entry.eventType))}</span>
                    <span className="text-muted-foreground">
                      · {t(capabilityLabelKey(entry.capability))}
                    </span>
                    {entry.modelId ? (
                      <code className="font-mono text-muted-foreground">{entry.modelId}</code>
                    ) : null}
                  </div>
                  <div className="text-muted-foreground">
                    {formatTimestamp(entry.createdAt, t("settings.developer.neverUsed"))}
                    {entry.inputTokens + entry.outputTokens > 0
                      ? ` · ${format("settings.developer.tokensUsed", {
                          input: entry.inputTokens,
                          output: entry.outputTokens,
                        })}`
                      : ""}
                  </div>
                </div>
                <div className="font-mono font-medium tabular-nums text-foreground">
                  {formatNanoCny(entry.deltaAvailableNanoCny)}
                </div>
              </div>
            ))}
          </SettingsCard>
        )}
      </SettingsSectionShell>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("settings.developer.createModalTitle")}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-caption font-medium text-foreground">
                  {t("settings.developer.keyNameLabel")}
                </label>
                <Input
                  data-testid="developer-key-name-input"
                  value={newKeyName}
                  onChange={(event) => setNewKeyName(event.target.value)}
                  placeholder={t("settings.developer.keyNamePlaceholder")}
                  maxLength={80}
                />
              </div>
              <div className="space-y-1.5">
                <div className="text-caption font-medium text-foreground">
                  {t("settings.developer.scopesLabel")}
                </div>
                <div className="flex flex-wrap gap-2">
                  {ALL_CAPABILITIES.map((cap) => {
                    const active = selectedScopes.includes(cap);
                    return (
                      <Button
                        key={cap}
                        size="xs"
                        variant={active ? "default" : "outline"}
                        data-testid={`developer-scope-toggle-${cap}`}
                        onClick={() => toggleScope(cap)}
                      >
                        {t(capabilityLabelKey(cap))}
                      </Button>
                    );
                  })}
                </div>
              </div>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setCreateOpen(false)}>
              {t("settings.developer.cancel")}
            </Button>
            <Button
              size="sm"
              disabled={!newKeyName.trim() || createKeyMutation.isPending}
              data-testid="developer-create-submit"
              onClick={() => void handleCreateSubmit()}
            >
              {createKeyMutation.isPending ? <Spinner decorative /> : null}
              {t("settings.developer.createSubmit")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
