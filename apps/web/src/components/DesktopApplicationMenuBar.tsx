import { isElectron } from "~/env";
import { isMacNavigatorPlatform } from "~/lib/utils";
import { AppNavigationButtons } from "./AppNavigationButtons";

/**
 * The title bar of the full-window pages (图像, 资料空间): a drag band with the route arrows.
 * It used to add 文件 编辑 视图 帮助 menus (copied from the Codex layout); no other page shows
 * them, so they are gone and these pages read like 收信箱 or 自动化.
 */
export function DesktopApplicationMenuBar() {
  if (!isElectron || isMacNavigatorPlatform()) return null;
  return (
    <header
      data-moss-destination-menubar
      className="drag-region fixed inset-x-0 top-0 z-40 flex h-11 items-center gap-1 pl-1 pr-36 text-muted-foreground"
    >
      <AppNavigationButtons className="ms-0" />
    </header>
  );
}
