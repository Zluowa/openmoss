// FILE: PhoneAccessCard.tsx
// Purpose: The desktop app's "Allow phone connections" switch.
// Layer: Connection settings UI
//
// The desktop owns this setting: flipping it restarts Moss's background service onto an
// address phones can reach, so the card waits for the service to answer again before it
// lets go of the switch. Plain browser clients never render it.
import type { DesktopBridge, DesktopPhoneAccessState } from "@moss/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Switch } from "~/components/ui/switch";
import { useTranslation } from "~/localization";
import { SettingsCard, SettingsRow } from "./SettingsPanelPrimitives";
import { phoneAccessProblemKey } from "./phonePairingModel";

export type PhoneAccessBridge = NonNullable<DesktopBridge["phoneAccess"]>;

export function PhoneAccessCard({
  bridge,
  onRestarting,
  onRestarted,
}: {
  readonly bridge: PhoneAccessBridge;
  /** The background service is about to drop; requests will fail for a moment. */
  readonly onRestarting: () => void;
  /** It answers again (or gave up); reload what the panel shows. */
  readonly onRestarted: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<DesktopPhoneAccessState | null>(null);
  const [applying, setApplying] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void bridge.getState().then(
      (next) => {
        if (mounted.current) setState(next);
      },
      () => undefined,
    );
    return () => {
      mounted.current = false;
    };
  }, [bridge]);

  const apply = useCallback(
    async (request: { readonly enabled: boolean }) => {
      if (applying) return;
      setApplying(true);
      // Show the choice at once; the real state replaces it when the restart is done.
      setState((current) => (current ? { ...current, ...request } : current));
      onRestarting();
      try {
        const next = await bridge.set(request);
        if (mounted.current) setState(next);
      } catch {
        const next = await bridge.getState().catch(() => null);
        if (mounted.current && next) setState({ ...next, error: "restart-failed" });
      }
      await onRestarted();
      if (mounted.current) setApplying(false);
    },
    [applying, bridge, onRestarted, onRestarting],
  );

  if (!state) return null;
  const unavailable = state.unavailableReason !== null;
  const problemKey = phoneAccessProblemKey(state);
  return (
    <div data-testid="phone-access">
      <SettingsCard>
        <SettingsRow
          title={t("settings.phone.access.title")}
          description={t("settings.phone.access.description")}
          status={
            applying ? (
              <span role="status">{t("settings.phone.access.restarting")}</span>
            ) : problemKey ? (
              <span role={unavailable ? undefined : "alert"}>{t(problemKey)}</span>
            ) : (
              t("settings.phone.access.notice")
            )
          }
          control={
            <Switch
              checked={state.enabled && !unavailable}
              disabled={applying || unavailable}
              onCheckedChange={(checked) => void apply({ enabled: Boolean(checked) })}
              aria-label={t("settings.phone.access.title")}
            />
          }
        />
      </SettingsCard>
    </div>
  );
}
