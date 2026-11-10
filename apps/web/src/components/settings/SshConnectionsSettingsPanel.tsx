// FILE: SshConnectionsSettingsPanel.tsx
// Purpose: Compact SSH devices, config import, details and verified remote connections.
// Layer: Desktop connection settings
import { SSH_SETTINGS_TARGET } from "~/connectionSettingsNavigation";
import type { SshConfigHost, SshConnection, SshConnectionState } from "@moss/contracts";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Switch } from "~/components/ui/switch";
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "~/components/ui/dialog";
import {
  DeviceLaptopIcon,
  EllipsisIcon,
  GlobeIcon,
  InfoIcon,
  Loader2Icon,
  PencilIcon,
  RefreshCwIcon,
  ServerIcon,
  SettingsIcon,
  TrashCanIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation, type TranslationKey } from "~/localization";
import { LARGE_DIALOG_TITLE_CLASS_NAME } from "~/surfaceStyles";
import { SettingsCard } from "./SettingsPanelPrimitives";
import { SshConnectionEditor } from "./SshConnectionEditor";
import {
  SSH_ERROR_KEYS,
  SSH_STATUS_KEYS,
  SSH_PHASE_KEYS,
  sshFailureTranslationKey,
  sshHostIdentity,
} from "./sshConnectionsSettingsModel";

export function SshConnectionsSettingsPanel({ active = true }: { readonly active?: boolean }) {
  const { t, format } = useTranslation();
  const api = window.desktopBridge?.ssh;
  const hostLabelPrefix = useId();
  const [connections, setConnections] = useState<ReadonlyArray<SshConnectionState>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<TranslationKey | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<SshConnection | "new" | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<SshConnection | null>(null);
  const [removePending, setRemovePending] = useState(false);
  const [removeError, setRemoveError] = useState<TranslationKey | null>(null);
  const [trustId, setTrustId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [hosts, setHosts] = useState<ReadonlyArray<SshConfigHost>>([]);
  const [hostsLoading, setHostsLoading] = useState(false);
  const [hostsError, setHostsError] = useState(false);
  const [selectedHosts, setSelectedHosts] = useState<ReadonlySet<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [savingIds, setSavingIds] = useState<ReadonlySet<string>>(new Set());
  const [enabledDraft, setEnabledDraft] = useState<ReadonlyMap<string, boolean>>(new Map());
  const sequence = useRef(0),
    hostsSequence = useRef(0);
  const operationVersions = useRef(new Map<string, number>());
  const mounted = useRef(true);
  const activeRef = useRef(active);
  activeRef.current = active;
  const pendingAttempts = useRef(new Set<string>());
  const connectQueue = useRef<SshConnection[]>([]);
  const queueRunning = useRef(false),
    pausedQueueId = useRef<string | null>(null);
  const importVersion = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const id of pendingAttempts.current) void api?.disconnect(id).catch(() => undefined);
      pendingAttempts.current.clear();
      connectQueue.current = [];
    };
  }, [api]);
  const refresh = useCallback(async () => {
    if (!api) {
      setLoading(false);
      return;
    }
    const request = ++sequence.current;
    try {
      const next = await api.list();
      if (mounted.current && request === sequence.current) {
        setConnections(next);
        setLoadError(false);
      }
    } catch {
      if (mounted.current && request === sequence.current) setLoadError(true);
    } finally {
      if (mounted.current && request === sequence.current) setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    if (!active) {
      importVersion.current++;
      connectQueue.current = [];
      pausedQueueId.current = null;
      for (const id of pendingAttempts.current) {
        operationVersions.current.set(id, (operationVersions.current.get(id) ?? 0) + 1);
        void api?.disconnect(id).catch(() => undefined);
      }
      pendingAttempts.current.clear();
      setTrustId(null);
      setPickerOpen(false);
      setEditing(null);
      setDetailsId(null);
      setImporting(false);
      return;
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [active, refresh]);
  const readConfig = useCallback(async () => {
    const request = ++hostsSequence.current;
    setHostsLoading(true);
    setHostsError(false);
    try {
      if (!api?.listConfigHosts) throw new Error("config-unavailable");
      const next = await api.listConfigHosts();
      if (!mounted.current || request !== hostsSequence.current) return;
      setHosts(next);
      const aliases = new Set(next.map((entry) => entry.alias));
      setSelectedHosts((selected) => new Set([...selected].filter((alias) => aliases.has(alias))));
    } catch {
      if (mounted.current && request === hostsSequence.current) setHostsError(true);
    } finally {
      if (mounted.current && request === hostsSequence.current) setHostsLoading(false);
    }
  }, [api]);
  const openPicker = () => {
    setSelectedHosts(new Set());
    setImportError(null);
    setPickerOpen(true);
    void readConfig();
  };
  const openDetails = (connection: SshConnection) => {
    setDetailsId(connection.id);
    void readConfig();
  };
  const replaceState = (state: SshConnectionState) =>
    setConnections((items) =>
      items.map((item) => (item.connection.id === state.connection.id ? state : item)),
    );
  const connect = async (
    connection: SshConnection,
    trustFingerprint?: string,
    version?: number,
  ) => {
    if (!api || !activeRef.current) return;
    pendingAttempts.current.add(connection.id);
    let result: SshConnectionState | undefined;
    const requestVersion = version ?? (operationVersions.current.get(connection.id) ?? 0) + 1;
    if (version === undefined) operationVersions.current.set(connection.id, requestVersion);
    replaceState({ connection, status: "connecting" });
    try {
      const state = await api.connect({
        id: connection.id,
        ...(trustFingerprint ? { trustFingerprint } : {}),
      });
      if (
        !mounted.current ||
        !activeRef.current ||
        operationVersions.current.get(connection.id) !== requestVersion
      )
        return;
      result = state;
      replaceState(state);
      if (state.status === "host-key-required") setTrustId(connection.id);
    } catch (cause) {
      if (mounted.current && operationVersions.current.get(connection.id) === requestVersion)
        setError(sshFailureTranslationKey(cause));
    } finally {
      if (
        result?.status !== "host-key-required" &&
        operationVersions.current.get(connection.id) === requestVersion
      )
        pendingAttempts.current.delete(connection.id);
      if (mounted.current && activeRef.current) await refresh();
    }
    return result;
  };
  // Batch imports connect one at a time and pause at each untrusted host/hop.
  const processQueue = async () => {
    if (queueRunning.current || !activeRef.current || pausedQueueId.current) return;
    queueRunning.current = true;
    try {
      while (activeRef.current && connectQueue.current.length) {
        const connection = connectQueue.current[0]!;
        const state = await connect(connection);
        if (!activeRef.current) return;
        if (connectQueue.current[0]?.id !== connection.id) continue;
        if (state?.status === "host-key-required") {
          pausedQueueId.current = connection.id;
          return;
        }
        connectQueue.current.shift();
      }
    } finally {
      queueRunning.current = false;
    }
  };
  const enqueueConnections = (items: ReadonlyArray<SshConnection>) => {
    const existing = new Set(connectQueue.current.map((connection) => connection.id));
    connectQueue.current.push(...items.filter((connection) => !existing.has(connection.id)));
    void processQueue();
  };
  const confirmTrust = async (connection: SshConnection, fingerprint: string) => {
    const state = await connect(connection, fingerprint);
    if (!activeRef.current || connectQueue.current[0]?.id !== connection.id) return;
    if (state?.status !== "host-key-required") {
      pausedQueueId.current = null;
      connectQueue.current.shift();
      void processQueue();
    }
  };
  // A switch stores intent, not a claim of connectivity. Only a settings write is locked;
  // a long remote prepare remains cancellable by switching off.
  const setEnabled = async (connection: SshConnection, enabled: boolean) => {
    if (!api || savingIds.has(connection.id)) return;
    const version = (operationVersions.current.get(connection.id) ?? 0) + 1;
    operationVersions.current.set(connection.id, version);
    setSavingIds((ids) => new Set(ids).add(connection.id));
    setEnabledDraft((draft) => new Map(draft).set(connection.id, enabled));
    setNotice(null);
    setError(null);
    try {
      const saved = await api.save({ ...connection, enabled });
      if (enabled && activeRef.current) void connect(saved, undefined, version);
      else {
        connectQueue.current = connectQueue.current.filter((item) => item.id !== connection.id);
        if (pausedQueueId.current === connection.id) pausedQueueId.current = null;
        pendingAttempts.current.delete(connection.id);
        await api.disconnect(connection.id);
        void processQueue();
        if (trustId === connection.id) setTrustId(null);
      }
      await refresh();
    } catch (cause) {
      setError(sshFailureTranslationKey(cause));
    } finally {
      setSavingIds((ids) => {
        const next = new Set(ids);
        next.delete(connection.id);
        return next;
      });
      setEnabledDraft((draft) => {
        const next = new Map(draft);
        next.delete(connection.id);
        return next;
      });
    }
  };
  const addSelected = async () => {
    if (!api || importing || selectedHosts.size === 0) return;
    setImporting(true);
    setImportError(null);
    const failed = new Set<string>();
    const savedConnections: SshConnection[] = [];
    const version = ++importVersion.current;
    let added = 0;
    try {
      const existing = new Set(
        (await api.list()).map((item) => sshHostIdentity(item.connection.host)),
      );
      for (const alias of selectedHosts) {
        if (!activeRef.current || version !== importVersion.current) return;
        if (existing.has(sshHostIdentity(alias))) continue;
        try {
          // Alias resolution stays in OpenSSH. Config metadata is never saved as overrides.
          savedConnections.push(await api.save({ displayName: alias, host: alias, enabled: true }));
          existing.add(sshHostIdentity(alias));
          added += 1;
        } catch {
          failed.add(alias);
        }
      }
      if (!activeRef.current || version !== importVersion.current) return;
      await refresh();
      enqueueConnections(savedConnections);
      if (failed.size) {
        setSelectedHosts(failed);
        setImportError(format("settings.ssh.config.partial", { added, failed: failed.size }));
      } else {
        setPickerOpen(false);
        setNotice(format("settings.ssh.config.added", { count: added }));
      }
    } catch {
      setImportError(t("settings.ssh.config.loadError"));
    } finally {
      if (activeRef.current && version === importVersion.current) setImporting(false);
    }
  };
  const remove = async () => {
    if (!api || !removing || removePending) return;
    setRemovePending(true);
    setRemoveError(null);
    try {
      await api.remove(removing.id);
      connectQueue.current = connectQueue.current.filter((item) => item.id !== removing.id);
      if (pausedQueueId.current === removing.id) pausedQueueId.current = null;
      pendingAttempts.current.delete(removing.id);
      void processQueue();
      if (detailsId === removing.id) setDetailsId(null);
      setRemoving(null);
      await refresh();
      setNotice(t("settings.ssh.removed"));
    } catch (cause) {
      setRemoveError(sshFailureTranslationKey(cause));
    } finally {
      setRemovePending(false);
    }
  };
  const details = connections.find((item) => item.connection.id === detailsId);
  const trust = connections.find((item) => item.connection.id === trustId);
  const importedHosts = new Set(connections.map((item) => sshHostIdentity(item.connection.host)));
  const configured = details
    ? hosts.find(
        (entry) => sshHostIdentity(entry.alias) === sshHostIdentity(details.connection.host),
      )
    : undefined;
  const visibleError = error ?? (loadError ? "settings.ssh.error.storage" : null);
  if (!active) return null;
  return (
    <div
      id={SSH_SETTINGS_TARGET}
      className="flex flex-col gap-5"
      data-testid="ssh-connections-settings"
    >
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-ui-lg font-semibold">{t("settings.ssh.fromThisComputer")}</h2>
        {connections.length > 0 ? (
          <Button className="rounded-full" size="sm" disabled={!api} onClick={openPicker}>
            {t("settings.ssh.addShort")}
          </Button>
        ) : null}
      </div>
      {!api ? (
        <p className="text-ui text-muted-foreground">{t("settings.ssh.desktopOnly")}</p>
      ) : null}
      {notice ? (
        <p role="status" className="text-ui text-muted-foreground">
          {notice}
        </p>
      ) : null}
      {visibleError ? (
        <div role="alert" className="flex items-center gap-2 text-ui text-destructive">
          <span>{t(visibleError)}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setError(null);
              void refresh();
            }}
          >
            {t("settings.ssh.refresh")}
          </Button>
        </div>
      ) : null}
      {loading ? (
        <p role="status" className="text-ui text-muted-foreground">
          {t("settings.ssh.loading")}
        </p>
      ) : connections.length === 0 ? (
        <SettingsCard>
          <div className="flex min-h-44 flex-col items-center justify-center gap-4 p-7 text-center">
            <div aria-hidden className="flex items-center gap-2 text-muted-foreground">
              <DeviceLaptopIcon className="size-7" />
              <EllipsisIcon className="size-4" />
              <ServerIcon className="size-7" />
            </div>
            <p className="text-ui text-muted-foreground">{t("settings.ssh.empty")}</p>
            <Button className="rounded-full" size="sm" disabled={!api} onClick={openPicker}>
              {t("settings.ssh.addShort")}
            </Button>
          </div>
        </SettingsCard>
      ) : (
        <SettingsCard>
          {connections.map((state) => {
            const { connection, status, phase, errorCode } = state;
            const enabled = enabledDraft.get(connection.id) ?? connection.enabled ?? false;
            return (
              <div
                key={connection.id}
                className="flex min-h-20 items-center gap-4 px-5 py-4"
                data-ssh-connection={connection.id}
              >
                <Switch
                  checked={enabled}
                  disabled={!api || savingIds.has(connection.id)}
                  aria-label={format("settings.ssh.enableAria", { name: connection.displayName })}
                  onCheckedChange={(checked) => void setEnabled(connection, checked)}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <GlobeIcon aria-hidden className="size-4 shrink-0 text-primary" />
                    <span className="truncate text-ui-lg font-medium">
                      {connection.displayName}
                    </span>
                  </div>
                  <div className="mt-0.5 flex min-w-0 items-center gap-1.5 ps-6 text-ui text-muted-foreground">
                    {status === "connecting" ? (
                      <Loader2Icon aria-hidden className="size-3.5 shrink-0 animate-spin" />
                    ) : (
                      <span
                        aria-hidden
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          status === "connected"
                            ? "bg-emerald-500"
                            : status === "failed"
                              ? "bg-destructive"
                              : "bg-muted-foreground/40",
                        )}
                      />
                    )}
                    <span role="status" className="truncate">
                      {t(
                        status === "connecting" && phase
                          ? SSH_PHASE_KEYS[phase]
                          : SSH_STATUS_KEYS[status],
                      )}
                    </span>
                    {errorCode ? (
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={t("settings.ssh.failureDetails")}
                        onClick={() => openDetails(connection)}
                      >
                        <InfoIcon className="size-3.5" />
                      </Button>
                    ) : null}
                    {status === "host-key-required" ? (
                      <Button size="xs" variant="link" onClick={() => setTrustId(connection.id)}>
                        {t("settings.ssh.verifyHost")}
                      </Button>
                    ) : null}
                  </div>
                </div>
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={format("settings.ssh.menuAria", {
                          name: connection.displayName,
                        })}
                      />
                    }
                  >
                    <EllipsisIcon className="size-5" />
                  </MenuTrigger>
                  <ComposerPickerMenuPopup align="end" className="min-w-40">
                    <MenuItem onClick={() => openDetails(connection)}>
                      <SettingsIcon className="size-4" />
                      {t("settings.ssh.settings")}
                    </MenuItem>
                    {enabled && (status === "failed" || status === "disconnected") ? (
                      <MenuItem onClick={() => void connect(connection)}>
                        <RefreshCwIcon className="size-4" />
                        {t("settings.ssh.retry")}
                      </MenuItem>
                    ) : null}
                    <MenuSeparator />
                    <MenuItem
                      onClick={() => {
                        setRemoveError(null);
                        setRemoving(connection);
                      }}
                    >
                      <TrashCanIcon className="size-4" />
                      {t("settings.ssh.delete")}
                    </MenuItem>
                  </ComposerPickerMenuPopup>
                </Menu>
              </div>
            );
          })}
        </SettingsCard>
      )}

      <Dialog
        open={pickerOpen}
        onOpenChange={(open) => {
          if (!importing) setPickerOpen(open);
        }}
      >
        <DialogPopup className="min-h-[min(32rem,80vh)] max-w-lg">
          <DialogHeader>
            <DialogTitle className={LARGE_DIALOG_TITLE_CLASS_NAME}>
              {t("settings.ssh.add")}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {t("settings.ssh.config.description")}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
            {hostsLoading ? (
              <p role="status" className="flex items-center gap-2 text-ui text-muted-foreground">
                <Loader2Icon className="size-4 animate-spin" />
                {t("settings.ssh.config.loading")}
              </p>
            ) : null}
            {hostsError ? (
              <p role="alert" className="mb-3 text-ui text-destructive">
                {t("settings.ssh.config.loadError")}
              </p>
            ) : null}
            {!hostsLoading && !hostsError && hosts.length === 0 ? (
              <p className="py-7 text-ui text-muted-foreground">{t("settings.ssh.config.empty")}</p>
            ) : null}
            {hosts.length > 0 ? (
              <SettingsCard>
                {hosts.map((entry, index) => {
                  const existing = importedHosts.has(sshHostIdentity(entry.alias));
                  return (
                    <label
                      key={entry.alias}
                      className="flex cursor-pointer items-center gap-3 px-4 py-3.5 text-ui"
                      data-ssh-config-alias={entry.alias}
                    >
                      <DeviceLaptopIcon
                        aria-hidden
                        className="size-5 shrink-0 text-muted-foreground"
                      />
                      <span
                        id={`${hostLabelPrefix}-${index}`}
                        className="min-w-0 flex-1 truncate font-medium"
                      >
                        {entry.alias}
                      </span>
                      {existing ? (
                        <span className="shrink-0 text-ui-sm text-muted-foreground">
                          {t("settings.ssh.config.alreadyAdded")}
                        </span>
                      ) : null}
                      <Checkbox
                        aria-labelledby={`${hostLabelPrefix}-${index}`}
                        className="size-ui-icon border-foreground/50 sm:size-ui-icon"
                        checked={existing || selectedHosts.has(entry.alias)}
                        disabled={existing || importing || hostsLoading}
                        onCheckedChange={(checked) =>
                          setSelectedHosts((selection) => {
                            const next = new Set(selection);
                            if (checked) next.add(entry.alias);
                            else next.delete(entry.alias);
                            return next;
                          })
                        }
                      />
                    </label>
                  );
                })}
              </SettingsCard>
            ) : null}
            {importError ? (
              <p role="alert" className="mt-3 text-ui text-destructive">
                {importError}
              </p>
            ) : null}
          </div>
          <DialogFooter className="justify-between">
            <div className="me-auto flex items-center gap-1">
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={importing || hostsLoading}
                aria-label={t("settings.ssh.config.refresh")}
                onClick={() => void readConfig()}
              >
                <RefreshCwIcon className="size-4" />
              </Button>
              <Button
                variant="ghost"
                disabled={importing}
                onClick={() => {
                  setPickerOpen(false);
                  setEditing("new");
                }}
              >
                {t("settings.ssh.manualAdd")}
              </Button>
            </div>
            <Button
              className="rounded-full"
              disabled={importing || hostsLoading || selectedHosts.size === 0}
              onClick={() => void addSelected()}
            >
              {t(importing ? "settings.ssh.config.adding" : "settings.ssh.addShort")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <SshConnectionEditor
        connection={editing}
        onClose={() => setEditing(null)}
        onSave={async (connection) => {
          if (!api) throw new Error("ssh-missing");
          const saved = await api.save(connection);
          await refresh();
          if (!activeRef.current) return;
          setEditing(null);
          setNotice(t("settings.ssh.saved"));
          if (saved.enabled) {
            operationVersions.current.set(
              saved.id,
              (operationVersions.current.get(saved.id) ?? 0) + 1,
            );
            await api.disconnect(saved.id);
            connectQueue.current = connectQueue.current.filter((item) => item.id !== saved.id);
            if (pausedQueueId.current === saved.id) pausedQueueId.current = null;
            if (activeRef.current) enqueueConnections([saved]);
          }
        }}
      />
      <Dialog
        open={Boolean(details)}
        onOpenChange={(open) => {
          if (!open) setDetailsId(null);
        }}
      >
        <DialogPopup className="max-w-lg">
          {details ? (
            <>
              <DialogHeader className="pe-20">
                <DialogTitle
                  className={cn(LARGE_DIALOG_TITLE_CLASS_NAME, "flex items-center gap-2")}
                >
                  <GlobeIcon className="size-5 text-primary" />
                  {details.connection.displayName}
                </DialogTitle>
                <DialogDescription className="sr-only">
                  {t("settings.ssh.details.description")}
                </DialogDescription>
                <span className="mt-1 w-fit rounded-full bg-foreground/6 px-2.5 py-0.5 text-ui-sm font-medium">
                  SSH
                </span>
              </DialogHeader>
              <Button
                className="absolute end-12 top-3"
                variant="ghost"
                size="icon-sm"
                aria-label={format("settings.ssh.editAria", {
                  name: details.connection.displayName,
                })}
                onClick={() => {
                  setDetailsId(null);
                  setEditing(details.connection);
                }}
              >
                <PencilIcon className="size-4" />
              </Button>
              <div className="min-h-0 space-y-3 overflow-y-auto px-5 pb-5">
                <SettingsCard>
                  <dl className="divide-y divide-border">
                    {[
                      [
                        t(
                          configured ? "settings.ssh.details.alias" : "settings.ssh.details.target",
                        ),
                        configured?.alias ?? details.connection.host,
                      ],
                      [t("settings.ssh.details.host"), configured?.host ?? details.connection.host],
                      [
                        t("settings.ssh.details.port"),
                        String(
                          details.connection.port ??
                            configured?.port ??
                            t("settings.ssh.defaultIdentity"),
                        ),
                      ],
                      [
                        t("settings.ssh.identityFile"),
                        details.connection.identityFile ??
                          configured?.identityFile ??
                          t("settings.ssh.defaultIdentity"),
                      ],
                    ].map(([label, value]) => (
                      <div
                        key={label}
                        className="flex items-baseline justify-between gap-5 px-4 py-3 text-ui"
                      >
                        <dt className="shrink-0 text-muted-foreground">{label}</dt>
                        <dd className="min-w-0 break-all text-right">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </SettingsCard>
                {hostsLoading ? (
                  <p role="status" className="text-ui-sm text-muted-foreground">
                    {t("settings.ssh.config.loading")}
                  </p>
                ) : null}
                {hostsError ? (
                  <p className="text-ui-sm text-muted-foreground">
                    {t("settings.ssh.details.configUnavailable")}
                  </p>
                ) : null}
                {details.errorCode ? (
                  <p role="alert" className="text-ui text-destructive">
                    {t(SSH_ERROR_KEYS[details.errorCode] ?? "settings.ssh.error.connection")}
                  </p>
                ) : null}
              </div>
            </>
          ) : null}
        </DialogPopup>
      </Dialog>
      <Dialog
        open={Boolean(trust?.fingerprint)}
        onOpenChange={(open) => {
          if (!open) setTrustId(null);
        }}
      >
        <DialogPopup className="max-w-lg">
          {trust?.fingerprint ? (
            <>
              <DialogHeader>
                <DialogTitle className={LARGE_DIALOG_TITLE_CLASS_NAME}>
                  {t(
                    trust.previousFingerprint
                      ? "settings.ssh.hostChanged"
                      : "settings.ssh.hostUnknown",
                  )}
                </DialogTitle>
                <DialogDescription>{t("settings.ssh.verifyDescription")}</DialogDescription>
              </DialogHeader>
              <div className="min-h-0 space-y-3 overflow-y-auto px-5 py-3 text-ui">
                <p className="font-medium">{trust.connection.displayName}</p>
                <p className="break-all text-muted-foreground">
                  {format("settings.ssh.verifyTarget", {
                    host: trust.hostKeyHost ?? trust.connection.host,
                  })}
                </p>
                {trust.previousFingerprint ? (
                  <div>
                    <p className="text-muted-foreground">{t("settings.ssh.previousFingerprint")}</p>
                    <p className="mt-1 break-all font-mono text-ui-sm">
                      {trust.previousFingerprint}
                    </p>
                  </div>
                ) : null}
                <p className="break-all font-mono text-ui-sm" data-testid="ssh-host-fingerprint">
                  {trust.fingerprint}
                </p>
              </div>
              <DialogFooter>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setTrustId(null);
                    void setEnabled(trust.connection, false);
                  }}
                >
                  {t("settings.ssh.cancel")}
                </Button>
                <Button
                  onClick={() => {
                    if (!trust.fingerprint) return;
                    setTrustId(null);
                    void confirmTrust(trust.connection, trust.fingerprint);
                  }}
                >
                  {t("settings.ssh.trustConnect")}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogPopup>
      </Dialog>
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !removePending) setRemoving(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.ssh.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {format("settings.ssh.deleteDescription", { name: removing?.displayName ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {removeError ? (
            <p role="alert" className="px-5 text-ui text-destructive">
              {t(removeError)}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={removePending} />}>
              {t("settings.ssh.cancel")}
            </AlertDialogClose>
            <Button variant="destructive" disabled={removePending} onClick={() => void remove()}>
              {t(removePending ? "settings.ssh.deleting" : "settings.ssh.delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
