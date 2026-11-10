import type { MossAppsAvailability } from "@moss/contracts";
import { useTranslation } from "~/localization";
import { Button } from "./ui/button";

/** Account scope stays beside the Apps catalog; no provider setup details. */
export function MossAppsAccountNotice({
  availability,
  onAction,
}: {
  readonly availability: MossAppsAvailability;
  readonly onAction: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex items-center justify-between gap-3 text-ui-xs text-muted-foreground"
      data-testid="moss-apps-account-notice"
    >
      <p>
        {t(
          availability === "ready"
            ? "apps.accountInfo"
            : availability === "authentication-required"
              ? "apps.error.login"
              : availability === "login-account-required"
                ? "apps.error.loginAccount"
                : availability === "unconfigured"
                  ? "apps.error.unconfigured"
                  : "apps.error.unavailable",
        )}
      </p>
      {availability !== "ready" ? (
        <Button variant="ghost" size="xs" onClick={onAction}>
          {t(
            availability === "authentication-required"
              ? "sidebar.accountMenu.signIn"
              : availability === "login-account-required"
                ? "sidebar.accountMenu.chooseAccount"
                : "apps.connect.retry",
          )}
        </Button>
      ) : null}
    </div>
  );
}
