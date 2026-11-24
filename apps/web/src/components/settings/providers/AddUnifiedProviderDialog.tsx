import type { UnifiedModelProviderConfig, UnifiedModelProviderProtocol } from "@moss/contracts";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { isImeComposingKeyEvent } from "~/lib/imeKeyEvent";
import {
  PROVIDER_BRAND_ICON_CATALOG,
  ProviderBrandIcon,
  ProviderBrandTile,
} from "~/components/ProviderBrandIcons";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  dialogFieldLabelClassName,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { SearchInput } from "~/components/ui/search-input";
import { SelectItem } from "~/components/ui/select";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  CheckIcon,
  ChevronLeftIcon,
  LockIcon,
  PencilIcon,
  PlusIcon,
  XIcon,
  ZapIcon,
} from "~/lib/icons";
import {
  UNIFIED_PROVIDER_PRESETS,
  type UnifiedProviderPreset,
  type UnifiedProviderPresetCategory,
} from "~/lib/unifiedProviderPresets";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { ensureNativeApi } from "~/nativeApi";
import { SettingsSelectControl } from "../SettingControls";
import { UNIFIED_PROTOCOL_LABEL, createUnifiedProviderId } from "./providerWorkbenchTypes";

type CategoryFilter = "all" | UnifiedProviderPresetCategory;

const PRESET_CATEGORIES: ReadonlyArray<{
  readonly id: CategoryFilter;
  readonly en: string;
  readonly zh: string;
}> = [
  { id: "all", en: "All", zh: "全部" },
  { id: "direct", en: "Direct", zh: "常用直连" },
  { id: "relay", en: "Gateways", zh: "聚合中转" },
  { id: "self-hosted", en: "Local & Custom", zh: "本地与自建" },
];

const CATEGORY_PILL_EASE = [0.32, 0.72, 0, 1] as const;

export function AddUnifiedProviderDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly existingProviders: ReadonlyArray<UnifiedModelProviderConfig>;
  readonly onSaved: (provider: UnifiedModelProviderConfig) => Promise<void> | void;
}) {
  const { locale } = useTranslation();
  const isZh = locale === "zh-CN";
  const reducedMotion = useReducedMotion();
  const [step, setStep] = useState<"presets" | "configure">("presets");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [search, setSearch] = useState("");
  const [presetId, setPresetId] = useState("deepseek");
  const [name, setName] = useState("DeepSeek");
  const [iconId, setIconId] = useState("deepseek");
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [protocol, setProtocol] = useState<UnifiedModelProviderProtocol>("openai-compatible");
  const [baseUrl, setBaseUrl] = useState("https://api.deepseek.com/v1");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<string[]>(["deepseek-chat", "deepseek-reasoner"]);
  const [modelDraft, setModelDraft] = useState("");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{
    readonly ok: boolean;
    readonly latencyMs?: number | undefined;
    readonly discoveredModels?: ReadonlyArray<string> | undefined;
    readonly error?: string | undefined;
  } | null>(null);

  useEffect(() => {
    if (!props.open) return;
    setStep("presets");
    setCategory("all");
    setSearch("");
    setIconPickerOpen(false);
    setTestResult(null);
    setApiKey("");
    setModelDraft("");
  }, [props.open]);

  const filteredPresets = useMemo(() => {
    const query = search.trim().toLowerCase();
    return UNIFIED_PROVIDER_PRESETS.filter((preset) => {
      if (category !== "all" && preset.category !== category) return false;
      if (!query) return true;
      return (
        preset.name.toLowerCase().includes(query) ||
        preset.nameZh.toLowerCase().includes(query) ||
        preset.baseUrl.toLowerCase().includes(query) ||
        preset.presetId.toLowerCase().includes(query)
      );
    });
  }, [category, search]);

  const applyPreset = (preset: UnifiedProviderPreset) => {
    setPresetId(preset.presetId);
    setName(isZh ? preset.nameZh : preset.name);
    setIconId(preset.iconId);
    setProtocol(preset.protocol);
    setBaseUrl(preset.baseUrl);
    setModels([...preset.suggestedModels]);
    setApiKey("");
    setTestResult(null);
    setIconPickerOpen(false);
    setStep("configure");
  };

  const addModelFromDraft = () => {
    const candidate = modelDraft.trim();
    if (!candidate) return;
    if (!models.includes(candidate)) {
      setModels((current) => [...current, candidate]);
    }
    setModelDraft("");
  };

  const handleTestConnection = async () => {
    const testFn = ensureNativeApi().server.testUnifiedProvider;
    if (!testFn) {
      setTestResult({
        ok: false,
        error: isZh ? "当前服务端不支持连接测试。" : "Server does not support provider testing.",
      });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testFn({
        protocol,
        baseUrl: baseUrl.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
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

  const handleSave = async () => {
    const saveFn = ensureNativeApi().server.saveUnifiedProvider;
    if (!saveFn) {
      toastManager.add({
        type: "error",
        title: isZh ? "无法保存服务商" : "Unable to save provider",
        description: isZh ? "桌面后端接口未连接。" : "Server RPC is unavailable.",
      });
      return;
    }
    setSaving(true);
    try {
      const existingIds = new Set(props.existingProviders.map((item) => item.id));
      const id = createUnifiedProviderId(presetId || name, existingIds);
      const saved = await saveFn({
        provider: {
          id,
          presetId: presetId || "custom",
          name: name.trim(),
          iconId,
          protocol,
          baseUrl: baseUrl.trim(),
          models,
          enabled: true,
        },
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      await props.onSaved(saved);
      props.onOpenChange(false);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: isZh ? "保存服务商失败" : "Failed to save provider",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-sans font-medium">
            {isZh ? "添加模型服务商" : "Add model provider"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {isZh
              ? "选择预设服务商或自定义端点，密钥将加密保存在系统钥匙串中。"
              : "Choose a preset or custom endpoint. API keys are encrypted in the OS keychain."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div key={step} className="sidebar-surface-enter">
            {step === "presets" ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="min-w-44 flex-1">
                    <SearchInput
                      shape="capsule"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder={isZh ? "搜索服务商…" : "Search providers…"}
                      aria-label={isZh ? "搜索模型服务商预设" : "Search provider presets"}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    {PRESET_CATEGORIES.map((item) => {
                      const active = category === item.id;
                      return (
                        <Button
                          key={item.id}
                          type="button"
                          size="xs"
                          shape="capsule"
                          variant="ghost"
                          className={cn(
                            "relative font-normal transition-colors duration-150",
                            active
                              ? "text-foreground hover:bg-transparent"
                              : "text-muted-foreground hover:bg-foreground/[0.035] hover:text-foreground",
                          )}
                          onClick={() => setCategory(item.id)}
                        >
                          {active ? (
                            <motion.span
                              layoutId="add-provider-category-pill"
                              aria-hidden="true"
                              transition={
                                reducedMotion
                                  ? { duration: 0 }
                                  : { duration: 0.16, ease: CATEGORY_PILL_EASE }
                              }
                              className="pointer-events-none absolute inset-0 rounded-full bg-foreground/[0.06]"
                            />
                          ) : null}
                          <span className="relative z-10">{isZh ? item.zh : item.en}</span>
                        </Button>
                      );
                    })}
                  </div>
                </div>

                <div className="grid max-h-[22rem] grid-cols-2 gap-1 overflow-y-auto py-1 sm:grid-cols-3">
                  {filteredPresets.map((preset) => (
                    <Button
                      key={preset.presetId}
                      type="button"
                      variant="ghost"
                      className="group h-9 w-full justify-start gap-2.5 rounded-row px-2.5 text-left font-normal text-foreground transition-[background-color,transform] duration-150 ease-snap hover:bg-foreground/[0.05] active:scale-[0.98] motion-reduce:transition-none"
                      onClick={() => applyPreset(preset)}
                    >
                      <ProviderBrandTile
                        variant="bare"
                        iconId={preset.iconId}
                        size="md"
                        className="transition-transform duration-150 group-hover:scale-110 motion-reduce:transition-none"
                      />
                      <span className="min-w-0 flex-1 truncate text-ui">
                        {isZh ? preset.nameZh : preset.name}
                      </span>
                    </Button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
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
                    <div>
                      <div className="text-ui-lg font-medium text-foreground">
                        {name || presetId}
                      </div>
                      <div className="text-ui-sm text-muted-foreground">
                        {isZh
                          ? UNIFIED_PROTOCOL_LABEL[protocol].zh
                          : UNIFIED_PROTOCOL_LABEL[protocol].en}
                      </div>
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="xs"
                    shape="capsule"
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={() => setStep("presets")}
                  >
                    <ChevronLeftIcon className="size-3.5" />
                    <span>{isZh ? "返回" : "Presets"}</span>
                  </Button>
                </div>

                {iconPickerOpen ? (
                  <div className="grid max-h-44 grid-cols-4 gap-1 overflow-y-auto rounded-card border border-border/70 bg-foreground/[0.02] p-2 sidebar-surface-enter sm:grid-cols-6">
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
                        <span className="w-full truncate text-center text-ui-xs">
                          {entry.label}
                        </span>
                      </Button>
                    ))}
                  </div>
                ) : null}

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label
                      htmlFor="add-unified-name"
                      className={cn("mb-1 block", dialogFieldLabelClassName)}
                    >
                      {isZh ? "服务商名称" : "Display name"}
                    </label>
                    <Input
                      id="add-unified-name"
                      size="sm"
                      variant="soft"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="DeepSeek"
                    />
                  </div>
                  <div>
                    <span className={cn("mb-1 block", dialogFieldLabelClassName)}>
                      {isZh ? "接口协议" : "API protocol"}
                    </span>
                    <SettingsSelectControl
                      value={protocol}
                      onValueChange={(value) => {
                        if (value) setProtocol(value as UnifiedModelProviderProtocol);
                      }}
                      ariaLabel={isZh ? "接口协议" : "API protocol"}
                      triggerClassName="w-full"
                      valueContent={
                        <span>
                          {isZh
                            ? UNIFIED_PROTOCOL_LABEL[protocol].zh
                            : UNIFIED_PROTOCOL_LABEL[protocol].en}
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
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="add-unified-url"
                    className={cn("mb-1 block", dialogFieldLabelClassName)}
                  >
                    {isZh ? "服务地址" : "Endpoint URL"}
                  </label>
                  <Input
                    id="add-unified-url"
                    size="sm"
                    variant="soft"
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    placeholder="https://api.deepseek.com/v1"
                    spellCheck={false}
                  />
                </div>

                <div>
                  <div className="mb-1 flex items-center gap-1.5">
                    <label htmlFor="add-unified-key" className={dialogFieldLabelClassName}>
                      {isZh ? "API 密钥" : "API Key"}
                    </label>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span
                            className="inline-flex cursor-help items-center text-muted-foreground/70 transition-colors hover:text-foreground"
                            aria-label={
                              isZh ? "已加密保存在系统钥匙串中" : "Encrypted in OS keychain"
                            }
                          >
                            <LockIcon className="size-3.5" />
                          </span>
                        }
                      />
                      <TooltipPopup side="top">
                        {isZh ? "已加密保存在系统钥匙串中" : "Encrypted in the OS keychain"}
                      </TooltipPopup>
                    </Tooltip>
                  </div>
                  <Input
                    id="add-unified-key"
                    size="sm"
                    variant="soft"
                    type="password"
                    autoComplete="new-password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={
                      isZh
                        ? "粘贴 API 密钥（本地服务可留空）"
                        : "Paste API key (optional for local)"
                    }
                  />
                </div>

                <div className="space-y-2">
                  <span className={cn("block", dialogFieldLabelClassName)}>
                    {isZh ? "可用模型列表" : "Models"}
                  </span>
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
                            onClick={() =>
                              setModels((current) => current.filter((item) => item !== model))
                            }
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
                      placeholder={isZh ? "输入模型名称后按回车…" : "Add model id and press Enter"}
                      className="flex-1"
                    />
                    <Button type="button" size="sm" variant="outline" onClick={addModelFromDraft}>
                      <PlusIcon className="size-3.5" />
                      {isZh ? "添加" : "Add"}
                    </Button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <Button
                    type="button"
                    size="sm"
                    shape="capsule"
                    variant="outline"
                    disabled={testing || !baseUrl.trim()}
                    onClick={() => void handleTestConnection()}
                    className="transition-transform duration-120 active:scale-[0.98] motion-reduce:transition-none"
                  >
                    {testing ? (
                      <Spinner aria-label="" className="size-3.5" />
                    ) : testResult?.ok ? (
                      <CheckIcon className="size-3.5 text-success" />
                    ) : (
                      <ZapIcon className="size-3.5" />
                    )}
                    {isZh ? "测试连接" : "Test connection"}
                  </Button>
                  {testResult ? (
                    <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
                      <span
                        className={cn(
                          "truncate text-ui-sm tabular-nums",
                          testResult.ok ? "text-success" : "text-destructive",
                        )}
                      >
                        {testResult.ok
                          ? isZh
                            ? `可用 · ${testResult.latencyMs ?? 0}ms${testResult.discoveredModels?.length ? ` · 发现 ${testResult.discoveredModels.length} 个模型` : ""}`
                            : `Connected · ${testResult.latencyMs ?? 0}ms${testResult.discoveredModels?.length ? ` · ${testResult.discoveredModels.length} models` : ""}`
                          : testResult.error || (isZh ? "连接失败" : "Connection failed")}
                      </span>
                      {testResult.ok && (testResult.discoveredModels?.length ?? 0) > 0 ? (
                        <Button
                          type="button"
                          size="xs"
                          shape="capsule"
                          variant="outline"
                          onClick={() => {
                            const discovered = testResult.discoveredModels ?? [];
                            setModels((current) =>
                              Array.from(new Set([...current, ...discovered])),
                            );
                          }}
                        >
                          <PlusIcon className="size-3" />
                          {isZh ? "导入模型" : "Import"}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            shape="capsule"
            onClick={() => props.onOpenChange(false)}
          >
            {isZh ? "取消" : "Cancel"}
          </Button>
          {step === "configure" ? (
            <Button
              type="button"
              variant="default"
              shape="capsule"
              disabled={saving || !name.trim() || !baseUrl.trim()}
              onClick={() => void handleSave()}
            >
              {saving ? <Spinner aria-label="" className="size-3.5" /> : null}
              {isZh ? "保存" : "Save provider"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
