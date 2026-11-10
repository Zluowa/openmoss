// FILE: ComposerImageModelNotice.tsx
// Purpose: One calm line beside the composer's images when the chosen model cannot see them.
// Layer: Chat composer presentation
// Exports: ComposerImageModelNotice
//
// The answer comes from the same capability source the server uses when it hands a
// conversation to another model (@moss/shared/modelImageInput), so the composer never
// promises what the next turn will not do.

import { modelImageInputSupport } from "@moss/shared/modelImageInput";

import { InfoIcon } from "~/lib/icons";
import { useTranslation } from "~/localization";

import { Button } from "../ui/button";

export function ComposerImageModelNotice(props: {
  readonly imageCount: number;
  readonly instanceId: string | null | undefined;
  readonly model: string | null | undefined;
  readonly onChangeModel: () => void;
}) {
  const { t } = useTranslation();
  if (
    props.imageCount === 0 ||
    modelImageInputSupport({ instanceId: props.instanceId, model: props.model }) !== "unsupported"
  ) {
    return null;
  }
  return (
    <div
      role="status"
      className="-mx-0.5 -mt-1 mb-2 flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs"
      data-composer-image-model-notice=""
    >
      <InfoIcon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{t("chat.composer.imageModelUnsupported")}</span>
      <Button
        size="xs"
        variant="ghost"
        className="h-5 shrink-0 px-1.5 text-foreground"
        onClick={props.onChangeModel}
      >
        {t("chat.composer.imageModelUnsupported.action")}
      </Button>
    </div>
  );
}
