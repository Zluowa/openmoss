// FILE: SpaceCreateMenu.tsx
// Purpose: The 创建 menu of the 资料空间: every kind of item, templates and uploads: only
//          what can be created now (a new 资料空间 has its own + in the sidebar).
// Layer: Space UI

import type { ReactElement } from "react";

import {
  CloudUploadIcon,
  DataDashboardIcon,
  ImagesIcon,
  PageTextIcon,
  PaletteIcon,
  SlidesIcon,
  TableIcon,
  TemplateIcon,
  WindowAppIcon,
  type LucideIcon,
} from "~/lib/icons";

import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { Badge } from "../ui/badge";
import { Menu, MenuGroup, MenuItem, MenuSeparator, MenuTrigger } from "../ui/menu";
import { spaceKindMeta } from "./spaceKinds";

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
}

const GROUPS: ReadonlyArray<ReadonlyArray<SpaceCreateMenuEntry>> = [
  [
    { id: "page", label: "文档", icon: PageTextIcon },
    { id: "slides", label: "幻灯片", icon: SlidesIcon },
    { id: "sheet", label: "电子表格", icon: TableIcon, badge: "Beta" },
    { id: "board", label: "画布", icon: spaceKindMeta("board").icon, badge: "Beta" },
    { id: "design", label: "设计", icon: PaletteIcon },
    { id: "dashboard", label: "数据看板", icon: DataDashboardIcon },
    { id: "app", label: "应用页", icon: WindowAppIcon },
    { id: "image", label: "图像", icon: ImagesIcon },
  ],
  [
    { id: "template", label: "从模板开始", icon: TemplateIcon },
    { id: "upload", label: "上传文件", icon: CloudUploadIcon },
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
                return (
                  <MenuItem
                    key={entry.id}
                    data-space-create={entry.id}
                    onClick={() => props.onCreate(entry.id)}
                  >
                    <Icon aria-hidden className="size-4 shrink-0" />
                    <span className="truncate">{entry.label}</span>
                    {entry.badge ? (
                      <Badge variant="secondary" size="sm" className="ml-auto shrink-0">
                        {entry.badge}
                      </Badge>
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
