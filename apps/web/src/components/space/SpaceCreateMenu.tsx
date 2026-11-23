// FILE: SpaceCreateMenu.tsx
// Purpose: The 创建 menu of the 资料空间: every kind of item, a new 资料空间, templates,
//          uploads and plugin connections, in one short list.
// Layer: Space UI

import type { ReactElement } from "react";

import {
  CloudUploadIcon,
  DataDashboardIcon,
  FoldersIcon,
  GlobeIcon,
  ImagesIcon,
  PageTextIcon,
  PaletteIcon,
  PluginIcon,
  SlidesIcon,
  TableIcon,
  TemplateIcon,
  WhiteboardIcon,
  WindowAppIcon,
  type LucideIcon,
} from "~/lib/icons";

import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { Badge } from "../ui/badge";
import { Menu, MenuGroup, MenuItem, MenuSeparator, MenuTrigger } from "../ui/menu";

/** What the user picked; the destination decides what each one opens. */
export type SpaceCreateAction =
  | "page"
  | "slides"
  | "sheet"
  | "board"
  | "design"
  | "dashboard"
  | "site"
  | "app"
  | "image"
  | "space"
  | "template"
  | "upload"
  | "plugin";

interface SpaceCreateMenuEntry {
  readonly id: SpaceCreateAction;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly badge?: string;
  readonly disabledHint?: string;
}

const GROUPS: ReadonlyArray<ReadonlyArray<SpaceCreateMenuEntry>> = [
  [
    { id: "page", label: "文档", icon: PageTextIcon },
    { id: "slides", label: "幻灯片", icon: SlidesIcon },
    { id: "sheet", label: "电子表格", icon: TableIcon, badge: "Beta" },
    { id: "board", label: "白板", icon: WhiteboardIcon, badge: "Beta" },
    { id: "design", label: "设计", icon: PaletteIcon },
    { id: "dashboard", label: "数据看板", icon: DataDashboardIcon },
    { id: "app", label: "应用页", icon: WindowAppIcon },
    { id: "image", label: "图像", icon: ImagesIcon },
  ],
  [
    { id: "template", label: "从模板开始", icon: TemplateIcon },
    { id: "space", label: "资料空间", icon: FoldersIcon },
    { id: "upload", label: "上传文件", icon: CloudUploadIcon },
  ],
  [
    { id: "site", label: "站点", icon: GlobeIcon, disabledHint: "页面内发布" },
    { id: "plugin", label: "连接插件", icon: PluginIcon, disabledHint: "即将推出" },
  ],
];

export function SpaceCreateMenu(props: {
  /** The element that opens the menu; it receives the trigger props. */
  trigger: ReactElement;
  onCreate: (action: SpaceCreateAction) => void;
  align?: "start" | "end";
}) {
  return (
    <Menu>
      <MenuTrigger render={props.trigger} />
      <ComposerPickerMenuPopup align={props.align ?? "start"} className="w-56 min-w-56">
        {GROUPS.map((group, index) => (
          <div key={group[0]!.id}>
            {index > 0 ? <MenuSeparator /> : null}
            <MenuGroup>
              {group.map((entry) => {
                const Icon = entry.icon;
                const isDisabled = entry.disabledHint !== undefined;
                return (
                  <MenuItem
                    key={entry.id}
                    data-space-create={entry.id}
                    disabled={isDisabled}
                    onClick={isDisabled ? undefined : () => props.onCreate(entry.id)}
                  >
                    <Icon aria-hidden className="size-4 shrink-0" />
                    <span className="truncate">{entry.label}</span>
                    {entry.badge ? (
                      <Badge variant="secondary" size="sm" className="ml-auto shrink-0">
                        {entry.badge}
                      </Badge>
                    ) : null}
                    {entry.disabledHint ? (
                      <span className="ml-auto shrink-0 text-ui-xs text-muted-foreground">
                        {entry.disabledHint}
                      </span>
                    ) : null}
                  </MenuItem>
                );
              })}
            </MenuGroup>
          </div>
        ))}
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
