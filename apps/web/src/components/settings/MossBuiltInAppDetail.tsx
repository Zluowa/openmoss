// FILE: MossBuiltInAppDetail.tsx
// Purpose: Settings › 插件 › 应用 › one Moss app: icon, name, one line, the
//          on/off switch, 打开 for apps with their own surface, what it does,
//          and three "try asking" prompts that each start a chat.
// Layer: Web settings component
// Exports: MossBuiltInAppDetail

import type { MossBuiltInAppPanel } from "@moss/shared/mossBuiltInApps";

import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { ChevronLeftIcon, ChevronRightIcon } from "~/lib/icons";
import { useTranslation } from "~/localization";
import { PAGE_TITLE_CLASS_NAME } from "~/surfaceStyles";
import { mossBuiltInAppPresentation, type MossBuiltInAppView } from "./mossBuiltInAppsPresentation";

export interface MossBuiltInAppDetailProps {
  readonly app: MossBuiltInAppView;
  readonly onBack: () => void;
  readonly onSetEnabled?: ((enabled: boolean) => void) | undefined;
  readonly onOpenPanel?: ((panel: MossBuiltInAppPanel) => void) | undefined;
  readonly onTryPrompt?: ((prompt: string) => void) | undefined;
}

export function MossBuiltInAppDetail({
  app,
  onBack,
  onSetEnabled,
  onOpenPanel,
  onTryPrompt,
}: MossBuiltInAppDetailProps) {
  const { format, t } = useTranslation();
  const presentation = mossBuiltInAppPresentation(app.id);
  const Icon = presentation.icon;
  const name = t(presentation.nameKey);
  const panel = app.panel;
  return (
    <div data-testid="moss-app-detail" data-app-id={app.id} className="flex flex-col gap-8">
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 h-7 gap-1 px-2 text-muted-foreground hover:text-foreground"
          onClick={onBack}
        >
          <ChevronLeftIcon aria-hidden="true" className="size-4" />
          {t("mossApps.detail.back")}
        </Button>
      </div>
      <header className="flex flex-wrap items-center gap-4">
        <span className="flex size-14 shrink-0 items-center justify-center rounded-card bg-card ring-1 ring-border/70 ring-inset">
          <Icon aria-hidden="true" className="size-7 text-foreground" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className={PAGE_TITLE_CLASS_NAME}>{name}</h2>
          <p className="text-ui-lg leading-5 text-muted-foreground">
            {t("mossApps.detail.builtBy")} · {t(presentation.descriptionKey)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {panel && onOpenPanel ? (
            <Button
              variant="secondary"
              size="sm"
              className="text-ui-lg sm:text-ui-lg"
              data-testid="moss-app-detail-open"
              onClick={() => onOpenPanel(panel)}
            >
              {t("mossApps.detail.open")}
            </Button>
          ) : null}
          <Switch
            className="min-h-6"
            checked={app.enabled}
            disabled={!onSetEnabled}
            onCheckedChange={(checked) => onSetEnabled?.(Boolean(checked))}
            aria-label={format("plugins.manage.toggleAria", { name })}
          />
        </div>
      </header>
      <p
        data-testid="moss-app-detail-status"
        className="-mt-4 text-ui leading-5 text-muted-foreground"
      >
        {app.enabled ? t("mossApps.detail.on") : t("mossApps.detail.off")}
      </p>
      <section className="flex flex-col gap-2">
        <h3 className="text-ui-lg font-medium text-foreground">{t("mossApps.detail.about")}</h3>
        <p className="text-ui-lg leading-6 text-muted-foreground">{t(presentation.aboutKey)}</p>
      </section>
      <section className="flex flex-col gap-3">
        <h3 className="text-ui-lg font-medium text-foreground">{t("mossApps.detail.tryIt")}</h3>
        <div className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-card border border-border/70">
          {presentation.promptKeys.map((key) => {
            const prompt = t(key);
            return (
              <Button
                key={key}
                variant="ghost"
                data-testid="moss-app-detail-prompt"
                disabled={!onTryPrompt || !app.enabled}
                onClick={() => onTryPrompt?.(prompt)}
                // A row of the list: full width, square corners inside the card.
                className="h-auto min-h-12 w-full justify-between gap-3 rounded-none px-4 py-2.5 text-left text-ui-lg font-normal text-foreground sm:text-ui-lg"
              >
                <span className="min-w-0 flex-1 truncate">{prompt}</span>
                <ChevronRightIcon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground"
                />
              </Button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
