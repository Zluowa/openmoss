import { useLayoutEffect } from "react";
import { useMossImagesAccountBoundary } from "~/lib/mossImagesAccountBoundary";
import { useTranslation } from "~/localization";
import { useMossLibraryItemsStore } from "~/mossLibraryItemsStore";
import { MossLibrarySurface, type MossLibrarySurfaceProps } from "./MossLibrarySurface";
import type { MossLibraryItem } from "./MossLibrarySurface.logic";

/** Retire another account's previews before paint; keep its persisted files untouched. */
export function MossLibraryDestination(
  props: Omit<MossLibrarySurfaceProps, "onStartConversation"> & {
    readonly onStartConversation: (
      items: readonly MossLibraryItem[],
      isCurrent: () => boolean,
    ) => Promise<void>;
  },
) {
  const { t } = useTranslation();
  const account = useMossImagesAccountBoundary();
  useLayoutEffect(() => {
    useMossLibraryItemsStore.getState().resetAccountBoundary();
  }, [account.key]);
  return account.transitioning ? (
    <div role="status">{t("library.switchingAccount")}</div>
  ) : (
    <MossLibrarySurface
      key={account.key}
      {...props}
      isCurrent={account.isCurrent}
      onStartConversation={(items) => props.onStartConversation(items, account.isCurrent)}
    />
  );
}
