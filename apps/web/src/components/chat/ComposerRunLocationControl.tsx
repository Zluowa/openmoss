import { ChevronDownIcon, DeviceLaptopIcon } from "~/lib/icons";
import { useTranslation } from "~/localization";
import { Menu, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
import { COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME } from "./composerPickerStyles";

/** Moss has a local executor; a worktree changes its directory, not its run location. */
export function ComposerRunLocationControl() {
  const { t } = useTranslation();
  const label = t("composer.cloudFollowUp.tooltip");
  return (
    <Menu>
      <MenuTrigger
        type="button"
        aria-label={label}
        title={label}
        data-composer-navigation-target="run-location"
        className={`${COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME} shrink-0`}
      >
        <DeviceLaptopIcon aria-hidden="true" className="size-4 shrink-0" />
        <span className="max-w-40 truncate">{t("composer.cloudFollowUp.local")}</span>
        <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0" />
      </MenuTrigger>
      <ComposerPickerMenuPopup align="start" side="top" aria-label={label}>
        <div className="px-2.5 py-1.5 text-ui-lg text-muted-foreground">
          {t("composer.cloudFollowUp.header")}
        </div>
        <MenuRadioGroup value="local">
          <MenuRadioItem value="local">{t("composer.cloudFollowUp.local")}</MenuRadioItem>
          <MenuRadioItem value="cloud" disabled>
            <span className="flex flex-col gap-0.5">
              <span>{t("composer.cloudFollowUp.cloud")}</span>
              <span className="text-ui-sm">{t("composer.runLocation.cloudUnavailable")}</span>
            </span>
          </MenuRadioItem>
        </MenuRadioGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
