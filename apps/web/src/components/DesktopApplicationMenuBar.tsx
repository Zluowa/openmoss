import { desktopTitleBarBandShown } from "~/lib/desktopTitleBar";

/**
 * The title band of the full-window pages (图像, 资料空间) on Windows: they have no page header,
 * so this band is what the window is dragged by. It holds nothing: the sidebar toggle and the
 * back/forward arrows are the shell's one cluster, painted over it at the same place as on every
 * other page (walk R-9). It sits under that cluster and before it in the document, so the
 * cluster takes the clicks and its no-drag box wins over the band's drag area.
 */
export function DesktopApplicationMenuBar() {
  if (!desktopTitleBarBandShown()) return null;
  return (
    <div
      aria-hidden
      data-moss-destination-menubar
      className="drag-region fixed inset-x-0 top-0 z-20 h-11"
    />
  );
}
