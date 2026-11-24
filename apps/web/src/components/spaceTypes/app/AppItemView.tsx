// FILE: AppItemView.tsx
// Purpose: Opens an 应用页 (仪表盘, 跟踪表, 投票…) made from a template in the 资料空间.
// Layer: 资料空间 types stream, readonly AppItem preview
// Why: AppItem is a versioned typed page payload, separate from page_apps.
// It has no published capability consent; the preview never calls an owner broker.

import { parseAppItem } from "@moss/shared/spaceItems/itemData";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import type {
  SpaceCanvasDockController,
  SpaceCanvasHostInsets,
  SpaceCanvasSelectionContext,
} from "../../space/spaceCanvasDockContract";
import { ReadonlyAppItemFrame } from "./ReadonlyAppItemFrame";
import { readonlyAppItemCopy } from "./readonlyAppItemCopy";

import { DashboardLayoutIcon } from "~/lib/icons";
import { useTranslation } from "~/localization";

export interface AppItemHostChrome {
  hideTopBar?: boolean;
  bottomInsetPx?: number;
  rightInsetPx?: number;
}

export function AppItemView(props: {
  pageId: string;
  revision: number;
  dataRevision: number | null;
  title: string;
  data: string;
  dock?: SpaceCanvasDockController | null;
  hostInsets?: SpaceCanvasHostInsets;
  hostChrome?: AppItemHostChrome;
  onHostActionsChange?: (actions: ReactNode | null) => void;
}) {
  const { locale } = useTranslation();
  const copy = readonlyAppItemCopy(locale);
  const { onHostActionsChange, dock } = props;
  const app = useMemo(() => {
    try {
      return parseAppItem(props.data);
    } catch {
      return null;
    }
  }, [props.data]);

  const dockSetSelection = dock?.setSelection;
  useEffect(() => {
    if (!dockSetSelection || !app) return;
    const selection: SpaceCanvasSelectionContext = {
      kind: "app",
      itemId: props.pageId,
      title: props.title || copy.title,
    };
    dockSetSelection(selection);
  }, [app, copy.title, dockSetSelection, props.pageId, props.title]);

  const capabilitySummary = useMemo(
    () =>
      app?.capabilities.length
        ? app.capabilities
            .map((name) => copy.capability[name])
            .join(locale === "zh-CN" ? "、" : ", ")
        : "",
    [app, copy.capability, locale],
  );

  useEffect(() => {
    if (!onHostActionsChange) return;
    if (!app || props.dataRevision === null) {
      onHostActionsChange(null);
      return;
    }
    onHostActionsChange(
      <div
        className="flex items-center gap-1.5 text-ui-xs text-muted-foreground"
        data-app-host-status
      >
        <DashboardLayoutIcon className="size-3.5" aria-hidden />
        <span>{copy.title}</span>
        {capabilitySummary ? (
          <span className="max-w-44 truncate">
            · {copy.unavailable}: {capabilitySummary}
          </span>
        ) : null}
        <span>· {copy.limit}</span>
      </div>,
    );
    return () => onHostActionsChange(null);
  }, [
    app,
    capabilitySummary,
    copy.limit,
    copy.title,
    copy.unavailable,
    onHostActionsChange,
    props.dataRevision,
  ]);

  const [dockInsets, setDockInsets] = useState<SpaceCanvasHostInsets | null>(null);
  const dockRegisterInsets = dock?.registerHostInsets;
  useEffect(() => {
    if (!dockRegisterInsets) {
      setDockInsets(null);
      return;
    }
    return dockRegisterInsets((next) => setDockInsets(next));
  }, [dockRegisterInsets]);

  if (!app || props.dataRevision === null) {
    return (
      <p role="alert" className="p-8 text-destructive">
        {copy.invalid}
      </p>
    );
  }

  const bottomInsetPx =
    props.hostChrome?.bottomInsetPx ??
    props.hostInsets?.bottomInsetPx ??
    dockInsets?.bottomInsetPx ??
    0;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-app-item>
      <div className="min-h-0 flex-1">
        <ReadonlyAppItemFrame
          context={{
            audience: "owner",
            document: {
              source: {
                sourceKind: "page-item",
                pageId: props.pageId,
                pageRevision: props.revision,
                dataRevision: props.dataRevision,
              },
              html: app.html,
              publicMetadata: { title: props.title, revision: props.revision },
            },
          }}
        />
      </div>
      {dock && capabilitySummary ? (
        <div
          className="pointer-events-none absolute inset-x-0 z-10 flex justify-center px-3"
          style={{ bottom: Math.max(12, bottomInsetPx + 12) }}
          data-app-floating-pill
        >
          <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-border bg-popover/95 px-2 py-1 shadow-md backdrop-blur-sm">
            <span className="max-w-48 truncate px-1.5 text-ui-xs text-muted-foreground">
              {copy.limit}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
