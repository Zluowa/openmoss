// FILE: TransportCompatibilityView.tsx
// Purpose: Shows localized recovery guidance for terminal WebSocket compatibility failures.
// Layer: Web UI

import { type WsCompatibilityAction, type WsCompatibilityError } from "@synara/contracts";

import { APP_DISPLAY_NAME, APP_VERSION } from "../branding";
import { Button, dialogActionButtonClassName } from "./ui/button";
import { type TranslationKey, useTranslation } from "../localization";

const TITLE_KEYS = {
  "update-client": "compatibility.title.updateClient",
  "update-server": "compatibility.title.updateServer",
  reload: "compatibility.title.reload",
} as const satisfies Record<WsCompatibilityAction, TranslationKey>;

const GUIDANCE_KEYS = {
  "update-client": "compatibility.guidance.updateClient",
  "update-server": "compatibility.guidance.updateServer",
  reload: "compatibility.guidance.reload",
} as const satisfies Record<WsCompatibilityAction, TranslationKey>;

const REASON_KEYS = {
  WS_PROTOCOL_INCOMPATIBLE: "compatibility.reason.protocol",
  WS_CAPABILITIES_INCOMPATIBLE: "compatibility.reason.capabilities",
  WS_NEGOTIATION_REQUIRED: "compatibility.reason.negotiation",
  WS_SERVER_GENERATION_CHANGED: "compatibility.reason.serverRestarted",
} as const satisfies Record<WsCompatibilityError["code"], TranslationKey>;

export function transportCompatibilityTranslationKeys(issue: WsCompatibilityError): {
  readonly title: TranslationKey;
  readonly reason: TranslationKey;
  readonly guidance: TranslationKey;
} {
  return {
    title: TITLE_KEYS[issue.action],
    reason: REASON_KEYS[issue.code],
    guidance: GUIDANCE_KEYS[issue.action],
  };
}

export function TransportCompatibilityView({ issue }: { readonly issue: WsCompatibilityError }) {
  const { format, t } = useTranslation();
  const keys = transportCompatibilityTranslationKeys(issue);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-amber-500)_16%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>
      <section className="relative w-full max-w-xl rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
        <p className="text-ui-xs font-semibold text-muted-foreground">{APP_DISPLAY_NAME}</p>
        <h1 className="mt-3 text-2xl font-semibold sm:text-3xl">
          {format(keys.title, { appName: APP_DISPLAY_NAME })}
        </h1>
        <p className="mt-2 text-ui-lg leading-relaxed text-muted-foreground">{t(keys.reason)}</p>
        <p className="mt-2 text-ui-lg leading-relaxed text-muted-foreground">
          {format(keys.guidance, { appName: APP_DISPLAY_NAME })}
        </p>
        <p className="mt-4 text-ui-sm text-muted-foreground/80">
          {t("compatibility.version.client")}{" "}
          <span data-localization-origin="runtime">{APP_VERSION}</span>
          {" · "}
          {t("compatibility.version.server")}{" "}
          <span data-localization-origin="runtime">{issue.serverBuild}</span>
        </p>
        <div className="mt-5">
          <Button
            size="sm"
            className={dialogActionButtonClassName}
            onClick={() => window.location.reload()}
          >
            {t("compatibility.reloadButton")}
          </Button>
        </div>
      </section>
    </div>
  );
}
