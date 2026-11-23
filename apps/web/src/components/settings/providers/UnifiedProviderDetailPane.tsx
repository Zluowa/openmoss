import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type UnifiedModelProviderConfig,
  type UnifiedModelProviderProtocol,
} from "@moss/contracts";
import { useEffect, useState } from "react";
import { isImeComposingKeyEvent } from "~/lib/imeKeyEvent";
import {
  PROVIDER_BRAND_ICON_CATALOG,
  ProviderBrandIcon,
  ProviderBrandTile,
} from "~/components/ProviderBrandIcons";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { SelectItem } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  CheckIcon,
  Loader2Icon,
  LockIcon,
  PencilIcon,
  PlusIcon,
  StarFilledIcon,
  StarIcon,
  TrashCanIcon,
  XIcon,
  ZapIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { ensureNativeApi } from "~/nativeApi";
import { SettingsSelectControl } from "../SettingControls";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSectionShell,
} from "../SettingsPanelPrimitives";
import {
  cliBrandIconId,
  UNIFIED_PROTOCOL_LABEL,
  resolveEffectiveCliSourceUi,
} from "./providerWorkbenchTypes";

export function UnifiedProviderDetailPane(props: {
  readonly provider: UnifiedModelProviderConfig;
  readonly activeCliProviders: ReadonlyArray<ProviderKind>;
  readonly defaultUnifiedProviderId: string | null | undefined;
  readonly unifiedProviderByCli: Readonly<Record<string, string>> | undefined;
  readonly onUpdated: () => Promise<void> | void;
  readonly onDeleted: (deletedId: string) => Promise<void> | void;
  readonly onRouteCli: (driver: ProviderKind, source: string) => Promise<void>;
  readonly onSetGlobalDefault: (id: string | null) => Promise<void>;
}) {
  const { locale } = useTranslation();
  const isZh = locale === "zh-CN";
  const [name, setName] = useState(props.provider.name);
  const [iconId, setIconId] = useState(props.provider.iconId);
  const [protocol, setProtocol] = useState<UnifiedModelProviderProtocol>(props.provider.protocol);
  const [baseUrl, setBaseUrl] = useState(props.provider.baseUrl);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [models, setModels] = useState<string[]>([...props.provider.models]);
  const [enabled, setEnabled] = useState(props.provider.enabled);
  const [modelDraft, setModelDraft] = useState("");
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [testResult, setTestResult] = useState<{
    readonly ok: boolean;
    readonly latencyMs?: number | undefined;
    readonly discoveredModels?: ReadonlyArray<string> | undefined;
    readonly error?: string | undefined;
  } | null>(null);

  useEffect(() => {
    setName(props.provider.name);
    setIconId(props.provider.iconId);
    setProtocol(props.provider.protocol);
    setBaseUrl(props.provider.baseUrl);
    setApiKeyDraft("");
    setModels([...props.provider.models]);
    setEnabled(props.provider.enabled);
    setModelDraft("");
    setIconPickerOpen(false);
    setConfirmDelete(false);
    setTestResult(null);
  }, [props.provider]);

  const isGlobalDefault = props.defaultUnifiedProviderId === props.provider.id;

  const persistProvider = async (nextEnabled = enabled) => {
    const saveFn = ensureNativeApi().server.saveUnifiedProvider;
    if (!saveFn) return;
    setSaving(true);
    try {
      await saveFn({
        provider: {
          id: props.provider.id,
          presetId: props.provider.presetId,
          name: name.trim() || props.provider.name,
          iconId,
          protocol,
          baseUrl: baseUrl.trim(),
          models,
          enabled: nextEnabled,
        },
        ...(apiKeyDraft.trim() ? { apiKey: apiKeyDraft.trim() } : {}),
      });
      setApiKeyDraft("");
      await props.onUpdated();
      toastManager.add({
        type: "success",
        title: isZh ? "服务商配置已保存" : "Provider configuration saved",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: isZh ? "保存失败" : "Failed to save provider",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    const testFn = ensureNativeApi().server.testUnifiedProvider;
    if (!testFn) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testFn({
        id: props.provider.id,
        protocol,
        baseUrl: baseUrl.trim(),
        ...(apiKeyDraft.trim() ? { apiKey: apiKeyDraft.trim() } : {}),
      });
      setTestResult(result);
    } catch (error) {
      setTestResult({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTesting(false);
    }
  };

  const handleDelete = async () => {
    const deleteFn = ensureNativeApi().server.deleteUnifiedProvider;
    if (!deleteFn) return;
    setDeleting(true);
    try {
      await deleteFn({ id: props.provider.id });
      await props.onDeleted(props.provider.id);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: isZh ? "删除服务商失败" : "Failed to delete provider",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setDeleting(false);
    }
  };

  const addModelFromDraft = () => {
    const candidate = modelDraft.trim();
    if (!candidate) return;
    if (!models.includes(candidate)) {
      setModels((current) => [...current, candidate]);
    }
    setModelDraft("");
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3 pb-1">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3.5">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    aria-label={isZh ? "更换图标" : "Change icon"}
                    onClick={() => setIconPickerOpen((open) => !open)}
                    className="group relative size-10 shrink-0 rounded-card p-0 transition-transform duration-150 hover:bg-transparent active:scale-95 motion-reduce:transition-none"
                  >
                    <ProviderBrandTile variant="tile" iconId={iconId} size="md" active />
                    <span
                      aria-hidden="true"
                      className="absolute -right-1 -bottom-1 inline-flex size-4 items-center justify-center rounded-full border border-border bg-popover text-muted-foreground opacity-0 shadow-xs transition-opacity duration-150 group-hover:opacity-100 motion-reduce:transition-none"
                    >
                      <PencilIcon className="size-2.5" />
                    </span>
                  </Button>
                }
              />
              <TooltipPopup side="top">{isZh ? "更换图标" : "Change icon"}</TooltipPopup>
            </Tooltip>
            <div className="min-w-0">
              <h2 className="truncate text-ui-lg font-medium text-foreground">
                {name || props.provider.name}
              </h2>
              <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-ui-sm text-muted-foreground">
                <span>
                  {isZh ? UNIFIED_PROTOCOL_LABEL[protocol].zh : UNIFIED_PROTOCOL_LABEL[protocol].en}
                </span>
                {props.provider.apiKeyConfigured ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="inline-flex items-center gap-1.5 text-success">
                      <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
                      <span>{isZh ? "已配置密钥" : "Key saved"}</span>
                    </span>
                  </>
                ) : null}
                {isGlobalDefault ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{isZh ? "全局默认" : "Global default"}</span>
                  </>
                ) : null}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Switch
              checked={enabled}
              aria-label={isZh ? `启用 ${props.provider.name}` : `Enable ${props.provider.name}`}
              onCheckedChange={(checked) => {
                const next = Boolean(checked);
                setEnabled(next);
                void persistProvider(next);
              }}
            />
            {confirmDelete ? (
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  size="xs"
                  shape="capsule"
                  variant="destructive"
                  disabled={deleting}
                  onClick={() => void handleDelete()}
                >
                  {isZh ? "确认删除" : "Confirm"}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  shape="capsule"
                  variant="ghost"
                  onClick={() => setConfirmDelete(false)}
                >
                  {isZh ? "取消" : "Cancel"}
                </Button>
              </div>
            ) : (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label={
                        isZh ? `删除 ${props.provider.name}` : `Delete ${props.provider.name}`
                      }
                      onClick={() => setConfirmDelete(true)}
                    >
                      <TrashCanIcon className="size-4 text-muted-foreground" />
                    </Button>
                  }
                />
                <TooltipPopup side="top">{isZh ? "删除" : "Delete"}</TooltipPopup>
              </Tooltip>
            )}
          </div>
        </div>

        {iconPickerOpen ? (
          <div className="grid max-h-48 grid-cols-4 gap-1 overflow-y-auto rounded-card border border-border/70 bg-foreground/[0.02] p-2 sidebar-surface-enter sm:grid-cols-6">
            {PROVIDER_BRAND_ICON_CATALOG.map((entry) => (
              <Button
                key={entry.iconId}
                type="button"
                size="xs"
                variant="ghost"
                className={cn(
                  "h-auto flex-col gap-1 rounded-row py-1.5 font-normal transition-[background-color,transform] duration-120 active:scale-95 motion-reduce:transition-none",
                  iconId === entry.iconId && "bg-foreground/[0.08] text-foreground",
                )}
                onClick={() => {
                  setIconId(entry.iconId);
                  setIconPickerOpen(false);
                }}
              >
                <ProviderBrandIcon iconId={entry.iconId} className="size-4" />
                <span className="w-full truncate text-center text-ui-xs">{entry.label}</span>
              </Button>
            ))}
          </div>
        ) : null}
      </div>

      <SettingsSection title={isZh ? "连接配置" : "Connection"}>
        <SettingsRow
          title={<label htmlFor="unified-detail-name">{isZh ? "名称" : "Display name"}</label>}
          control={
            <Input
              id="unified-detail-name"
              size="sm"
              variant="soft"
              className="w-full sm:w-56"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          }
        />

        <SettingsRow
          title={isZh ? "接口协议" : "API protocol"}
          control={
            <SettingsSelectControl
              value={protocol}
              onValueChange={(value) => {
                if (value) setProtocol(value as UnifiedModelProviderProtocol);
              }}
              ariaLabel={isZh ? "接口协议" : "API protocol"}
              triggerClassName="w-full sm:w-56"
              valueContent={
                <span>
                  {isZh ? UNIFIED_PROTOCOL_LABEL[protocol].zh : UNIFIED_PROTOCOL_LABEL[protocol].en}
                </span>
              }
            >
              {(Object.keys(UNIFIED_PROTOCOL_LABEL) as UnifiedModelProviderProtocol[]).map(
                (key) => (
                  <SelectItem hideIndicator key={key} value={key}>
                    {isZh ? UNIFIED_PROTOCOL_LABEL[key].zh : UNIFIED_PROTOCOL_LABEL[key].en}
                  </SelectItem>
                ),
              )}
            </SettingsSelectControl>
          }
        />

        <SettingsRow
          title={<label htmlFor="unified-detail-url">{isZh ? "服务地址" : "Endpoint URL"}</label>}
          control={
            <Input
              id="unified-detail-url"
              size="sm"
              variant="soft"
              className="w-full font-mono text-ui-sm sm:w-56"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              spellCheck={false}
            />
          }
        />

        <SettingsRow
          title={
            <span className="inline-flex items-center gap-1.5">
              <label htmlFor="unified-detail-key">{isZh ? "API 密钥" : "API Key"}</label>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      className="inline-flex cursor-help items-center text-muted-foreground/70 transition-colors hover:text-foreground"
                      aria-label={isZh ? "已加密保存在系统钥匙串中" : "Encrypted in OS keychain"}
                    >
                      <LockIcon className="size-3.5" />
                    </span>
                  }
                />
                <TooltipPopup side="top">
                  {isZh ? "已加密保存在系统钥匙串中" : "Encrypted in the OS keychain"}
                </TooltipPopup>
              </Tooltip>
            </span>
          }
          control={
            <Input
              id="unified-detail-key"
              size="sm"
              variant="soft"
              type="password"
              autoComplete="new-password"
              className="w-full sm:w-56"
              value={apiKeyDraft}
              onChange={(event) => setApiKeyDraft(event.target.value)}
              placeholder={
                props.provider.apiKeyConfigured
                  ? isZh
                    ? "留空保持现有密钥"
                    : "Leave blank to keep key"
                  : isZh
                    ? "粘贴 API 密钥"
                    : "Paste API key"
              }
            />
          }
        />

        <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              shape="capsule"
              variant="outline"
              disabled={testing || !baseUrl.trim()}
              onClick={() => void handleTest()}
              className="transition-transform duration-120 active:scale-[0.98] motion-reduce:transition-none"
            >
              {testing ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : testResult?.ok ? (
                <CheckIcon className="size-3.5 text-success" />
              ) : (
                <ZapIcon className="size-3.5" />
              )}
              {isZh ? "测试连接" : "Test connection"}
            </Button>
            {testResult ? (
              <span
                className={cn(
                  "text-ui-sm tabular-nums",
                  testResult.ok ? "text-success" : "text-destructive",
                )}
              >
                {testResult.ok
                  ? isZh
                    ? `可用 · ${testResult.latencyMs ?? 0}ms${testResult.discoveredModels?.length ? ` · ${testResult.discoveredModels.length} 个模型` : ""}`
                    : `Connected · ${testResult.latencyMs ?? 0}ms${testResult.discoveredModels?.length ? ` · ${testResult.discoveredModels.length} models` : ""}`
                  : testResult.error || (isZh ? "连接失败" : "Connection failed")}
              </span>
            ) : null}
            {testResult?.ok && (testResult.discoveredModels?.length ?? 0) > 0 ? (
              <Button
                type="button"
                size="xs"
                shape="capsule"
                variant="outline"
                onClick={() => {
                  const discovered = testResult.discoveredModels ?? [];
                  setModels((current) => Array.from(new Set([...current, ...discovered])));
                }}
              >
                <PlusIcon className="size-3" />
                {isZh ? "填入发现模型" : "Import models"}
              </Button>
            ) : null}
          </div>

          <Button
            type="button"
            size="sm"
            shape="capsule"
            variant="default"
            disabled={saving || !baseUrl.trim()}
            onClick={() => void persistProvider()}
            className="transition-transform duration-120 active:scale-[0.98] motion-reduce:transition-none"
          >
            {saving ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
            {isZh ? "保存" : "Save changes"}
          </Button>
        </div>
      </SettingsSection>

      <SettingsSectionShell title={isZh ? "模型列表" : "Models"}>
        <SettingsCard divided={false} className="space-y-3 p-3.5">
          {models.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {models.map((model) => (
                <span
                  key={model}
                  className="inline-flex items-center gap-1 rounded-control bg-foreground/[0.05] px-2 py-0.5 font-mono text-ui-xs text-foreground"
                >
                  <span>{model}</span>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    className="size-4 p-0 text-muted-foreground hover:text-foreground"
                    aria-label={`Remove ${model}`}
                    onClick={() => setModels((current) => current.filter((item) => item !== model))}
                  >
                    <XIcon className="size-3" />
                  </Button>
                </span>
              ))}
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            <Input
              size="sm"
              variant="soft"
              value={modelDraft}
              onChange={(event) => setModelDraft(event.target.value)}
              onKeyDown={(event) => {
                if (isImeComposingKeyEvent(event)) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  addModelFromDraft();
                }
              }}
              placeholder={isZh ? "输入模型名称后按回车…" : "Add model name…"}
              className="flex-1"
            />
            <Button type="button" size="sm" variant="outline" onClick={addModelFromDraft}>
              <PlusIcon className="size-3.5" />
              {isZh ? "添加" : "Add"}
            </Button>
          </div>
        </SettingsCard>
      </SettingsSectionShell>

      <SettingsSectionShell
        title={isZh ? "应用到编码智能体" : "Coding CLI routing"}
        action={
          <Button
            type="button"
            size="xs"
            shape="capsule"
            variant={isGlobalDefault ? "secondary" : "outline"}
            className="transition-transform duration-120 active:scale-95 motion-reduce:transition-none"
            onClick={() =>
              void props.onSetGlobalDefault(isGlobalDefault ? null : props.provider.id)
            }
          >
            {isGlobalDefault ? (
              <StarFilledIcon className="size-3" />
            ) : (
              <StarIcon className="size-3" />
            )}
            <span>
              {isGlobalDefault
                ? isZh
                  ? "全局默认"
                  : "Global default"
                : isZh
                  ? "设为全部默认"
                  : "Set as default"}
            </span>
          </Button>
        }
      >
        <SettingsCard divided={false} className="p-2">
          <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
            {props.activeCliProviders.map((driver) => {
              const effective = resolveEffectiveCliSourceUi({
                defaultUnifiedProviderId: props.defaultUnifiedProviderId,
                unifiedProviderByCli: props.unifiedProviderByCli,
                provider: driver,
              });
              const routedHere = effective === props.provider.id;
              return (
                <Button
                  key={driver}
                  type="button"
                  role="switch"
                  aria-checked={routedHere}
                  aria-label={
                    isZh
                      ? `让 ${PROVIDER_DISPLAY_NAMES[driver]} 使用 ${props.provider.name}`
                      : `Route ${PROVIDER_DISPLAY_NAMES[driver]} to ${props.provider.name}`
                  }
                  variant="ghost"
                  onClick={() =>
                    void props.onRouteCli(driver, routedHere ? "moss" : props.provider.id)
                  }
                  className={cn(
                    "h-9 w-full justify-between gap-2 rounded-row px-2.5 text-left font-normal transition-[background-color,color,transform] duration-150 ease-snap active:scale-[0.98] motion-reduce:transition-none",
                    routedHere
                      ? "bg-foreground/[0.07] text-foreground hover:bg-foreground/[0.09]"
                      : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <ProviderBrandTile
                      variant="bare"
                      iconId={cliBrandIconId(driver)}
                      cliProvider={driver}
                      size="sm"
                    />
                    <span className="truncate text-ui">{PROVIDER_DISPLAY_NAMES[driver]}</span>
                  </span>
                  <span
                    aria-hidden="true"
                    className={cn(
                      "inline-flex size-4 shrink-0 items-center justify-center rounded-full border transition-[background-color,border-color,transform] duration-150 motion-reduce:transition-none",
                      routedHere
                        ? "scale-100 border-transparent bg-foreground text-background"
                        : "scale-90 border-border/80 bg-transparent",
                    )}
                  >
                    {routedHere ? <CheckIcon className="size-2.5" /> : null}
                  </span>
                </Button>
              );
            })}
          </div>
        </SettingsCard>
      </SettingsSectionShell>
    </div>
  );
}
