// FILE: SpaceCreateMenu.tsx
// Purpose: The 创建 menu of the 资料空间: every kind of item, a new 资料空间, templates,
//          uploads and plugin connections, in one short list.
// Layer: Space UI

import type { ReactElement } from "react";

import {
  CloudUploadIcon,
  FoldersIcon,
  GlobeIcon,
  ImagesIcon,
  PageTextIcon,
  PluginIcon,
  SketchPenIcon,
  SlidesIcon,
  TableIcon,
  TemplateIcon,
  WindowAppIcon,
  type LucideIcon,
} from "~/lib/icons";

import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { Menu, MenuGroup, MenuItem, MenuSeparator, MenuTrigger } from "../ui/menu";

/** What the user picked; the destination decides what each one opens. */
export type SpaceCreateAction =
  | "page"
  | "slides"
  | "sheet"
  | "board"
  | "site"
  | "app"
  | "image"
  | "space"
  | "template"
  | "upload"
  | "plugin";

const GROUPS: ReadonlyArray<
  ReadonlyArray<{ id: SpaceCreateAction; label: string; icon: LucideIcon; hint?: string }>
> = [
  [
    { id: "page", label: "页面", icon: PageTextIcon },
    { id: "slides", label: "幻灯片", icon: SlidesIcon },
    { id: "sheet", label: "电子表格", icon: TableIcon },
    { id: "board", label: "白板", icon: SketchPenIcon },
    { id: "site", label: "站点", icon: GlobeIcon },
    { id: "app", label: "应用页", icon: WindowAppIcon },
    { id: "image", label: "图像", icon: ImagesIcon },
  ],
  [
    { id: "space", label: "资料空间", icon: FoldersIcon },
    { id: "template", label: "从模板开始", icon: TemplateIcon },
  ],
  [
    { id: "upload", label: "上传文件", icon: CloudUploadIcon },
    { id: "plugin", label: "连接插件", icon: PluginIcon },
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
      <ComposerPickerMenuPopup align={props.align ?? "start"} className="w-52 min-w-52">
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
                    {entry.label}
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
