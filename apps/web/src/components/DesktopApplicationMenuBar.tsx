import { useState } from "react";
import { isElectron } from "~/env";
import { isMacNavigatorPlatform } from "~/lib/utils";
import { AppNavigationButtons } from "./AppNavigationButtons";
import { Button } from "./ui/button";

const MENUS = [
  ["file", "文件"],
  ["edit", "编辑"],
  ["view", "视图"],
  ["help", "帮助"],
] as const;

/** Reuse Electron's real menu actions; the title bar only supplies their anchors. */
export function DesktopApplicationMenuBar() {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  if (!isElectron || isMacNavigatorPlatform()) return null;
  const showMenu = window.desktopBridge?.showApplicationMenu;
  return (
    <header
      data-moss-destination-menubar
      className="drag-region fixed inset-x-0 top-0 z-40 flex h-11 items-center gap-1 pl-1 pr-36 text-muted-foreground"
    >
      <AppNavigationButtons className="ms-0" />
      {showMenu &&
        MENUS.map(([id, label]) => (
          <Button
            key={id}
            type="button"
            variant="ghost"
            size="sm"
            className="no-drag rounded px-2 text-ui-lg"
            aria-haspopup="menu"
            aria-expanded={openMenu === id}
            onClick={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              setOpenMenu(id);
              void showMenu(id, { x: bounds.left, y: bounds.bottom })
                .catch(() => undefined)
                .finally(() => setOpenMenu(null));
            }}
          >
            {label}
          </Button>
        ))}
    </header>
  );
}
