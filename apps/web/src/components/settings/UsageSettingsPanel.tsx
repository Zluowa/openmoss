// FILE: UsageSettingsPanel.tsx
// Purpose: Settings → Usage & limits: Overview (each account's remaining quota and the
//          Moss plan) and Analytics (cost and tokens over time).
// Layer: Settings UI components
// Exports: UsageSettingsPanel

import { useState } from "react";

import { PillTabs } from "~/components/ui/pill-tabs";
import { useTranslation } from "~/localization";
import { ProviderUsageSettingsPanel } from "./ProviderUsageSettingsPanel";
import { UsageAnalyticsPanel } from "./UsageAnalyticsPanel";

type UsageTab = "overview" | "analytics";

export function UsageSettingsPanel() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<UsageTab>("overview");
  return (
    <div className="flex flex-col gap-8">
      <PillTabs
        ariaLabel={t("settings.usage.tabs.label")}
        selected={tab}
        onSelect={setTab}
        tabs={[
          { id: "overview", label: t("settings.usage.tabs.overview") },
          { id: "analytics", label: t("settings.usage.tabs.analytics") },
        ]}
      />
      {tab === "analytics" ? <UsageAnalyticsPanel /> : <ProviderUsageSettingsPanel />}
    </div>
  );
}
