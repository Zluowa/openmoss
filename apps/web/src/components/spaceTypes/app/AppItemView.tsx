// FILE: AppItemView.tsx
// Purpose: Opens an 应用页 (仪表盘, 跟踪表, 投票…) made from a template in the 资料空间.
// Layer: 资料空间 types stream, readonly AppItem preview
// Why: AppItem is a versioned typed page payload, separate from page_apps.
// It has no published capability consent; the preview never calls an owner broker.

import { parseAppItem } from "@moss/shared/spaceItems/itemData";
import { useMemo } from "react";

import { ReadonlyAppItemFrame } from "./ReadonlyAppItemFrame";
import { readonlyAppItemCopy } from "./readonlyAppItemCopy";

import { DashboardLayoutIcon } from "~/lib/icons";
import { useTranslation } from "~/localization";

export function AppItemView(props: {
  pageId: string;
  revision: number;
  dataRevision: number | null;
  title: string;
  data: string;
}) {
  const { locale } = useTranslation();
  const copy = readonlyAppItemCopy(locale);
  const app = useMemo(() => {
    try {
      return parseAppItem(props.data);
    } catch {
      return null;
    }
  }, [props.data]);
  if (!app || props.dataRevision === null) {
    return (
      <p role="alert" className="p-8 text-destructive">
        {copy.invalid}
      </p>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-app-item>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4 text-ui-sm text-muted-foreground">
        <DashboardLayoutIcon className="size-4" aria-hidden />
        <span>{copy.title}</span>
        {app.capabilities.length ? (
          <span className="truncate">
            · {copy.unavailable}:{" "}
            {app.capabilities
              .map((name) => copy.capability[name])
              .join(locale === "zh-CN" ? "、" : ", ")}
          </span>
        ) : null}
        <span className="ml-auto text-ui-xs">{copy.limit}</span>
      </div>
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
    </div>
  );
}
