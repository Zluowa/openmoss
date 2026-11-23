import type {
  ProviderInstanceId,
  ServerProviderStatus,
  ServerSettings,
  UnifiedModelProviderConfig,
} from "@moss/contracts";
import type { ReactNode } from "react";
import type { AppSettings, NewChatModelSource } from "~/appSettings";
import { SelectItem } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { useTranslation } from "~/localization";
import { providerStatusInstanceKey } from "~/lib/providerAvailability";
import { isProviderUpdateActive } from "~/providerUpdates";
import { cn } from "~/lib/utils";
import {
  SETTINGS_INSET_LIST_CLASS_NAME,
  SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME,
} from "~/settingsPanelStyles";
import {
  SettingResetButton,
  SettingsSegmentedControl,
  type SettingsSegmentedOption,
  SettingsSelectControl,
} from "../SettingControls";
import { SettingsListRow, SettingsRow, SettingsSection } from "../SettingsPanelPrimitives";

const NEW_CHAT_MODEL_SOURCE_OPTIONS: ReadonlyArray<SettingsSegmentedOption<NewChatModelSource>> = [
  { value: "moss", label: "Moss" },
  { value: "own", label: "Local account" },
];

export function ProvidersPreferencesPane(props: {
  readonly settings: AppSettings;
  readonly defaults: AppSettings;
  readonly serverSettings: ServerSettings | undefined;
  readonly unifiedProviders: ReadonlyArray<UnifiedModelProviderConfig>;
  readonly enabledProviderCount: number;
  readonly availableProviderCount: number;
  readonly visibleAvailableProviderCount: number;
  readonly hasPendingProviderStatuses: boolean;
  readonly isProviderOrderDirty: boolean;
  readonly hiddenProviderCount: number;
  readonly versionCheckSummary: string;
  readonly outdatedProviderStatuses: ReadonlyArray<ServerProviderStatus>;
  readonly updatingProviders: ReadonlySet<ProviderInstanceId>;
  readonly updateSettings: (patch: Partial<AppSettings>) => void;
  readonly onSetDefaultUnifiedProvider: (id: string | null) => Promise<void>;
  readonly renderVisibilityDragList: () => ReactNode;
  readonly renderUpdateAction: (status: ServerProviderStatus, active: boolean) => ReactNode;
  readonly getStatusDisplayName: (status: ServerProviderStatus) => string;
  readonly getUpdateStatusLabel: (status: ServerProviderStatus) => string | null;
}) {
  const { locale } = useTranslation();
  const isZh = locale === "zh-CN";
  const enabledUnified = props.unifiedProviders.filter((item) => item.enabled);
  const selectedGlobalDefault = props.serverSettings?.defaultUnifiedProviderId ?? "moss";
  const selectedGlobalDefaultLabel =
    selectedGlobalDefault === "moss" || !selectedGlobalDefault
      ? isZh
        ? "Moss 官方默认"
        : "Moss (default)"
      : (enabledUnified.find((item) => item.id === selectedGlobalDefault)?.name ??
        (isZh ? "Moss 官方默认" : "Moss (default)"));

  return (
    <div className="space-y-6">
      <SettingsSection title={isZh ? "默认路由" : "Defaults"}>
        <SettingsRow
          title={isZh ? "新建对话默认模型来源" : "Default provider for new chats"}
          control={
            <SettingsSegmentedControl
              ariaLabel="Default provider for new chats"
              value={props.settings.newChatModelSource}
              onValueChange={(newChatModelSource) => props.updateSettings({ newChatModelSource })}
              options={NEW_CHAT_MODEL_SOURCE_OPTIONS}
            />
          }
          resetAction={
            props.settings.newChatModelSource !== props.defaults.newChatModelSource ? (
              <SettingResetButton
                label="default provider for new chats"
                onClick={() =>
                  props.updateSettings({ newChatModelSource: props.defaults.newChatModelSource })
                }
              />
            ) : null
          }
        />

        <SettingsRow
          title={isZh ? "全局默认统一服务商" : "Global default unified provider"}
          description={
            isZh ? "未单独设置来源的智能体默认使用" : "Inherited by agents without a custom route"
          }
          control={
            <SettingsSelectControl
              value={selectedGlobalDefault || "moss"}
              onValueChange={(value) =>
                void props.onSetDefaultUnifiedProvider(!value || value === "moss" ? null : value)
              }
              ariaLabel={isZh ? "全局默认统一服务商" : "Global default unified provider"}
              triggerClassName="min-w-44"
              valueContent={<span className="truncate">{selectedGlobalDefaultLabel}</span>}
            >
              <SelectItem hideIndicator value="moss">
                {isZh ? "Moss 官方默认" : "Moss (default)"}
              </SelectItem>
              {enabledUnified.map((item) => (
                <SelectItem hideIndicator key={item.id} value={item.id}>
                  <span className="truncate">{item.name}</span>
                </SelectItem>
              ))}
            </SettingsSelectControl>
          }
        />
      </SettingsSection>

      <SettingsSection title={isZh ? "更新与性能" : "Updates & performance"}>
        <SettingsRow
          title={isZh ? "自动检查 CLI 更新" : "Automatic CLI update checks"}
          resetAction={
            props.settings.enableProviderUpdateChecks !==
            props.defaults.enableProviderUpdateChecks ? (
              <SettingResetButton
                label="CLI update checks"
                onClick={() =>
                  props.updateSettings({
                    enableProviderUpdateChecks: props.defaults.enableProviderUpdateChecks,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={props.settings.enableProviderUpdateChecks}
              onCheckedChange={(checked) =>
                props.updateSettings({ enableProviderUpdateChecks: Boolean(checked) })
              }
              aria-label="Automatic CLI update checks"
            />
          }
        />

        <SettingsRow
          title={isZh ? "可用更新" : "Provider updates"}
          status={props.versionCheckSummary}
        >
          {props.settings.enableProviderUpdateChecks &&
          props.outdatedProviderStatuses.length > 0 ? (
            <div
              className={cn(
                "mt-3",
                SETTINGS_INSET_LIST_CLASS_NAME,
                SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME,
              )}
            >
              {props.outdatedProviderStatuses.map((providerStatus) => {
                const instanceId = providerStatusInstanceKey(providerStatus);
                const updateActive =
                  isProviderUpdateActive(providerStatus) || props.updatingProviders.has(instanceId);
                const updateLabel = props.getUpdateStatusLabel(providerStatus);
                return (
                  <SettingsListRow
                    key={instanceId}
                    title={props.getStatusDisplayName(providerStatus)}
                    description={updateLabel || undefined}
                    actions={
                      providerStatus.versionAdvisory?.canUpdate ? (
                        props.renderUpdateAction(providerStatus, updateActive)
                      ) : (
                        <span className="text-ui-sm text-muted-foreground">
                          {isZh ? "需手动更新" : "Manual update"}
                        </span>
                      )
                    }
                  />
                );
              })}
            </div>
          ) : null}
        </SettingsRow>

        <SettingsRow
          title={isZh ? "保持 Moss 流畅响应" : "Keep Moss responsive"}
          description={
            isZh ? "系统繁忙时降低后台智能体 CPU 优先级" : "Lower agent CPU priority when busy"
          }
          status={
            isZh
              ? "对新启动进程生效"
              : "Applies to newly launched agent processes. Restart existing sessions to apply consistently."
          }
          resetAction={
            props.settings.lowerProviderProcessPriority !==
            props.defaults.lowerProviderProcessPriority ? (
              <SettingResetButton
                label="Keep Moss responsive"
                onClick={() =>
                  props.updateSettings({
                    lowerProviderProcessPriority: props.defaults.lowerProviderProcessPriority,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={props.settings.lowerProviderProcessPriority}
              onCheckedChange={(checked) =>
                props.updateSettings({ lowerProviderProcessPriority: Boolean(checked) })
              }
              aria-label="Keep Moss responsive"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={isZh ? "模型菜单排序" : "Model picker"}>
        <SettingsRow
          title={isZh ? "编码智能体显示与排序" : "Available CLIs"}
          description={isZh ? "拖拽排序或开关显示" : "Drag to reorder or toggle visibility"}
          status={
            props.hasPendingProviderStatuses
              ? isZh
                ? "正在检测…"
                : "Checking installed CLIs"
              : props.availableProviderCount === 0
                ? isZh
                  ? "未检测到已安装智能体"
                  : "No CLIs detected"
                : props.visibleAvailableProviderCount < props.availableProviderCount
                  ? isZh
                    ? `显示 ${props.visibleAvailableProviderCount} / ${props.availableProviderCount}`
                    : `${props.visibleAvailableProviderCount} of ${props.availableProviderCount} installed shown`
                  : props.isProviderOrderDirty
                    ? isZh
                      ? `${props.availableProviderCount} 个已安装 · 自定义顺序`
                      : `${props.availableProviderCount} installed · custom order`
                    : isZh
                      ? `${props.availableProviderCount} 个已安装`
                      : `${props.availableProviderCount} installed`
          }
          resetAction={
            props.hiddenProviderCount > 0 || props.isProviderOrderDirty ? (
              <SettingResetButton
                label="provider picker"
                onClick={() =>
                  props.updateSettings({
                    hiddenProviders: props.defaults.hiddenProviders,
                    providerOrder: props.defaults.providerOrder,
                  })
                }
              />
            ) : null
          }
        >
          <div className="mt-3">{props.renderVisibilityDragList()}</div>
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}
