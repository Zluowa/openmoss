// FILE: EnvironmentUsageSection.tsx
// Purpose: "Usage" section of the Environment panel — a compact menu per account of the active provider.

import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  type ProviderInstanceId,
  type ProviderKind,
  type ServerProviderUsageSnapshot,
} from "@moss/contracts";
import {
  deriveProviderInstances,
  type ResolvedProviderInstance,
} from "@moss/shared/providerInstances";
import { providerUsageDisplayName } from "@moss/shared/providerUsage";
import { useQuery } from "@tanstack/react-query";

import {
  ProviderUsageMenuPopup,
  useProviderUsageMenuModel,
} from "~/components/ProviderUsageMenuControl";
import { ProviderIcon } from "~/components/ProviderIcon";
import { MossLogo } from "~/components/MossLogo";
import {
  isMossPayQuotaUnlimited,
  resolveMossPayQuotaAccountIdentity,
} from "~/components/auth/MossPayPanel";
import {
  serverMossAccountSessionQueryOptions,
  serverMossCloudAccountStateQueryOptions,
  serverMossPayQuotaQueryOptions,
} from "~/components/auth/mossServerReactQuery";
import { isMossManagedSourceInstanceId } from "~/components/chat/providerAccountSources";
import { mossQuotaRemainingPercent } from "~/components/settings/MossBillingSettingsPanel";
import { useTranslation } from "~/localization";
import { openSettings } from "~/settingsDialogStore";
import { MenuTrigger } from "~/components/ui/menu";
import {
  serverAllProviderUsageQueryOptions,
  serverSettingsQueryOptions,
} from "~/lib/serverReactQuery";

import { resolveEnvironmentProviderUsageSummary } from "./EnvironmentUsageSection.logic";
import {
  ENVIRONMENT_ROW_CLASS_NAME,
  ENVIRONMENT_ROW_ICON_CLASS_NAME,
  EnvironmentLabeledSection,
  EnvironmentRow,
  EnvironmentRowBody,
  EnvironmentRowChevron,
} from "./EnvironmentRow";

function EnvironmentUsageAccountRow({
  instance,
  snapshot,
  label,
}: {
  instance: ResolvedProviderInstance;
  snapshot: ServerProviderUsageSnapshot;
  label: string;
}) {
  const provider = instance.driver;
  const model = useProviderUsageMenuModel(provider, {
    instanceId: instance.instanceId,
    providerSnapshot: snapshot,
  });
  const summary = resolveEnvironmentProviderUsageSummary({
    providerName: label,
    rows: model.rows,
    snapshot,
    hasUsageLines: model.usageLines.length > 0,
  });

  return (
    <ProviderUsageMenuPopup provider={provider} model={model} align="start" showUsageLines={true}>
      <MenuTrigger
        render={
          <button
            type="button"
            className={ENVIRONMENT_ROW_CLASS_NAME}
            aria-label={summary.ariaLabel}
          />
        }
      >
        <EnvironmentRowBody
          icon={
            <ProviderIcon
              provider={provider}
              tone="header"
              className={ENVIRONMENT_ROW_ICON_CLASS_NAME}
            />
          }
          label={label}
          trailing={
            <span className="flex items-center gap-1.5">
              {summary.rows.length > 0 ? (
                <span className="flex flex-col items-end gap-0.5 text-ui-xs leading-none">
                  {summary.rows.map((row) => (
                    <span key={row.id} className="flex items-baseline gap-1.5">
                      <span className="text-[var(--color-text-foreground-secondary)]">
                        {row.label}
                      </span>
                      <span className="min-w-7 text-right text-[var(--color-text-foreground)]">
                        {row.remainingLabel}
                      </span>
                    </span>
                  ))}
                </span>
              ) : (
                <span className="text-ui-xs text-[var(--color-text-foreground-secondary)]">
                  {summary.statusLabel}
                </span>
              )}
              <EnvironmentRowChevron />
            </span>
          }
        />
      </MenuTrigger>
    </ProviderUsageMenuPopup>
  );
}

/**
 * The chat runs on the Moss account: its usage is the Moss quota, one row that opens Usage
 * settings. The person's own CLI logins are not what this chat uses, so they are not listed
 * (a signed-out local row would read as if the chat needed a sign-in).
 */
function EnvironmentMossUsageRow() {
  const { format, t } = useTranslation();
  const phoneQuery = useQuery(serverMossAccountSessionQueryOptions());
  const accountQuery = useQuery(serverMossCloudAccountStateQueryOptions());
  const accountIdentity = resolveMossPayQuotaAccountIdentity(phoneQuery.data, accountQuery.data);
  const quotaQuery = useQuery(
    serverMossPayQuotaQueryOptions({ enabled: accountIdentity !== null, accountIdentity }),
  );
  const quota = quotaQuery.data;
  const quotaWindow = quota?.usageLimits.find((limit) => limit.limit !== null);
  const remaining = quotaWindow
    ? mossQuotaRemainingPercent(quotaWindow.used, quotaWindow.limit)
    : null;
  const status = quota
    ? isMossPayQuotaUnlimited(quota)
      ? t("mossPay.quota.unlimited")
      : remaining !== null
        ? format("mossPay.quota.remaining", { value: `${remaining}%` })
        : null
    : null;
  return (
    <EnvironmentRow
      aria-label={status ? `Moss, ${status}` : "Moss"}
      data-environment-usage-moss=""
      onClick={() => openSettings({ section: "usage" })}
      icon={<MossLogo className={ENVIRONMENT_ROW_ICON_CLASS_NAME} />}
      label="Moss"
      trailing={
        <span className="flex items-center gap-1.5">
          {status ? (
            <span className="text-ui-xs text-[var(--color-text-foreground-secondary)]">
              {status}
            </span>
          ) : null}
          <EnvironmentRowChevron />
        </span>
      }
    />
  );
}

export function EnvironmentUsageSection({
  provider,
  activeInstanceId = null,
}: {
  provider: ProviderKind;
  /** The account the chat runs on. */
  activeInstanceId?: ProviderInstanceId | null;
}) {
  const { locale } = useTranslation();
  const usageQuery = useQuery(serverAllProviderUsageQueryOptions());
  const settingsQuery = useQuery(serverSettingsQueryOptions());
  const onMoss = activeInstanceId !== null && isMossManagedSourceInstanceId(activeInstanceId);
  const providerInstances = deriveProviderInstances(
    settingsQuery.data ?? DEFAULT_SERVER_SETTINGS_VIEW,
  ).filter(
    (instance) =>
      instance.enabled &&
      instance.driver === provider &&
      // Moss accounts have no CLI usage of their own; their quota is the Moss row.
      !isMossManagedSourceInstanceId(instance.instanceId as ProviderInstanceId),
  );
  const accounts = providerInstances.flatMap((instance) => {
    const snapshot = usageQuery.data?.find(
      (entry) =>
        entry.provider === provider && (entry.instanceId ?? entry.provider) === instance.instanceId,
    );
    if (!snapshot) return [];
    const hasUsage =
      snapshot.limits.length > 0 ||
      snapshot.usageLines.length > 0 ||
      (snapshot.resetCredits?.availableCount ?? 0) > 0;
    // An account whose usage the provider can't report has nothing to show: a bare
    // "unsupported" row is noise, whichever account it is.
    if (!hasUsage && snapshot.status === "unsupported") return [];
    // Unused default providers should not crowd the panel. Configured extra
    // accounts stay visible so an expired login or failed usage check is clear.
    if (
      instance.isDefault &&
      providerInstances.length === 1 &&
      !instance.raw.displayName &&
      !hasUsage &&
      (snapshot.status === "needs-auth" || (snapshot.status ?? "ok") === "ok")
    )
      return [];
    const providerName = providerUsageDisplayName(provider);
    const showAccountName =
      !instance.isDefault || providerInstances.length > 1 || instance.displayName !== providerName;
    const accountName =
      instance.isDefault && instance.displayName === providerName
        ? locale === "zh-CN"
          ? "默认"
          : "Default"
        : instance.displayName;
    return [
      {
        instance,
        snapshot,
        label: showAccountName ? `${providerName} · ${accountName}` : providerName,
      },
    ];
  });

  if (onMoss) {
    return (
      <EnvironmentLabeledSection label="Usage">
        <EnvironmentMossUsageRow />
      </EnvironmentLabeledSection>
    );
  }

  if (accounts.length === 0) return null;

  return (
    <EnvironmentLabeledSection label="Usage">
      {accounts.map(({ instance, snapshot, label }) => (
        <EnvironmentUsageAccountRow
          key={instance.instanceId}
          instance={instance}
          snapshot={snapshot}
          label={label}
        />
      ))}
    </EnvironmentLabeledSection>
  );
}
