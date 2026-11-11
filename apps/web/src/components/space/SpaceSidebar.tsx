// FILE: SpaceSidebar.tsx
// Purpose: The 资料空间 panel: 创建, the item families (全部 / 页面 / 幻灯片 / 站点 / 图像 /
//          应用), 最近, the user's 资料空间 with their page trees, and 回收站.
// Layer: Space UI
// Geometry: the shared sidebar tokens (32px rows 2px apart, 16px glyphs, section labels at
//           footnote size), so this panel reads like every other rail destination's.

import { type ReactNode, useState } from "react";
import {
  SPACE_ICON_NAMES,
  type Page,
  type PageId,
  type PageSpace,
  type SpaceId,
} from "@moss/contracts";

import {
  AddPlusIcon,
  ChevronRightIcon,
  EllipsisIcon,
  FoldersIcon,
  GlobeIcon,
  ImagesIcon,
  LayoutGridIcon,
  PageTextIcon,
  SlidesIcon,
  TrashCanIcon,
  WindowAppIcon,
  XIcon,
  type LucideIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import {
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_NESTED_LIST_GAP_CLASS_NAME,
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
  SIDEBAR_SECTION_LABEL_CLASS_NAME,
} from "~/sidebarRowStyles";

import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { SidebarGlyph } from "../sidebarGlyphs";
import { SidebarIconButton } from "../SidebarIconButton";
import { SidebarLeadingIcon } from "../SidebarLeadingIcon";
import { SidebarPrimaryAction } from "../SidebarPrimaryAction";
import { SidebarPanelTitle } from "../SidebarPanelTitle";
import { SpaceIcon, SPACE_ICON_OPTIONS } from "../SpaceIcon";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { SidebarMenu, SidebarMenuItem } from "../ui/sidebar";
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from "../ui/menu";
import { SpaceCreateMenu, type SpaceCreateAction } from "./SpaceCreateMenu";
import { SpaceSyncMenuItem } from "./SpaceSyncMenuItem";
import {
  formatRelativeTime,
  spaceItemDisplayTitle,
  type SpaceItem,
  type SpaceKindSection,
  type SpaceSection,
} from "./spaceItems";
import { spaceItemMeta } from "./spaceKinds";

const KIND_ROWS: ReadonlyArray<{ kind: SpaceKindSection; label: string; icon: LucideIcon }> = [
  { kind: "page", label: "页面", icon: PageTextIcon },
  { kind: "slides", label: "幻灯片", icon: SlidesIcon },
  { kind: "site", label: "站点", icon: GlobeIcon },
  { kind: "image", label: "图像", icon: ImagesIcon },
  { kind: "app", label: "应用", icon: WindowAppIcon },
];

/** Space icons are stored as a Central glyph name from the curated Space set. */
export function isKnownSpaceIcon(
  icon: string | null | undefined,
): icon is (typeof SPACE_ICON_NAMES)[number] {
  return typeof icon === "string" && (SPACE_ICON_NAMES as readonly string[]).includes(icon);
}

export function SpaceSidebar(props: {
  scopeSpaceId: SpaceId | null;
  section: SpaceSection;
  /** Key of the open item, when one is open. */
  openKey: string | null;
  recent: readonly SpaceItem[];
  spaces: readonly PageSpace[];
  pages: readonly Page[];
  onSection: (section: SpaceSection) => void;
  onOpen: (item: SpaceItem) => void;
  onOpenPage: (pageId: PageId) => void;
  onCreate: (action: SpaceCreateAction) => void;
  onCreateSubpage: (parent: Page) => void;
  onRenameSpace: (space: PageSpace) => void;
  onSpaceIcon: (space: PageSpace, icon: string | null) => void;
  onTrashSpace: (space: PageSpace) => void;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const isSection = (section: SpaceSection) =>
    props.openKey === null && sameSection(props.section, section);
  const livePages = props.pages.filter((page) => page.trashedAt === null);

  const renderPage = (page: Page, depth: number, seen: ReadonlySet<PageId>): ReactNode => {
    if (seen.has(page.id) || depth > 32) return null;
    const children = livePages.filter((entry) => entry.parentPageId === page.id);
    const nextSeen = new Set([...seen, page.id]);
    const open = expanded.has(page.id);
    const active = props.openKey === `page:${page.id}`;
    const pageTitle = spaceItemDisplayTitle({ title: page.title, kind: "page" });
    return (
      <div key={page.id} className={cn("flex flex-col", SIDEBAR_NESTED_LIST_GAP_CLASS_NAME)}>
        <div
          className={cn(
            "group/space-row flex items-center",
            SIDEBAR_HEADER_ROW_CLASS_NAME,
            "p-0",
            active
              ? SIDEBAR_ROW_ACTIVE_CLASS_NAME
              : cn(SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME),
          )}
          style={{ paddingInlineStart: `${8 + depth * 14}px` }}
        >
          <button
            type="button"
            className="flex size-5 shrink-0 items-center justify-center rounded-inline text-muted-foreground hover:text-foreground disabled:opacity-0"
            aria-label={`${open ? "收起" : "展开"} ${pageTitle}`}
            aria-expanded={children.length ? open : undefined}
            disabled={children.length === 0}
            onClick={() => toggle(page.id)}
          >
            <ChevronRightIcon
              aria-hidden
              className={cn("size-3 transition-transform", open && "rotate-90")}
            />
          </button>
          <button
            type="button"
            className="min-w-0 flex-1 truncate py-1.5 pe-1 text-left"
            aria-current={active ? "page" : undefined}
            onClick={() => props.onOpenPage(page.id)}
          >
            {pageTitle}
          </button>
          <span className="pe-1 opacity-0 group-hover/space-row:opacity-100 group-focus-within/space-row:opacity-100">
            <SidebarIconButton
              icon={AddPlusIcon}
              label={`在 ${pageTitle} 下新建子页面`}
              onClick={() => props.onCreateSubpage(page)}
            />
          </span>
        </div>
        {children.length ? (
          <DisclosureRegion open={open}>
            <div className={cn("flex flex-col", SIDEBAR_NESTED_LIST_GAP_CLASS_NAME)}>
              {children.map((child) => renderPage(child, depth + 1, nextSeen))}
            </div>
          </DisclosureRegion>
        ) : null}
      </div>
    );
  };

  return (
    <aside
      className="flex w-70 shrink-0 flex-col border-r border-[color:var(--app-rail-inset-border,var(--border))] bg-[var(--app-rail-panel-background,var(--sidebar))] max-md:w-56"
      aria-label="资料空间导航"
      data-space-sidebar
    >
      <SidebarPanelTitle title="资料空间">
        <SidebarIconButton
          icon={XIcon}
          label="关闭资料空间"
          size="header"
          onClick={props.onClose}
        />
      </SidebarPanelTitle>
      {/* Same insets, rows and glyphs as the main sidebar's panels (SidebarPrimaryAction). */}
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pt-1 pb-1.5">
        <nav aria-label="条目">
          <SidebarMenu className="gap-0.5">
            <SidebarMenuItem>
              <SpaceCreateMenu
                onCreate={props.onCreate}
                trigger={
                  <button
                    type="button"
                    className={cn(
                      SIDEBAR_HEADER_ROW_CLASS_NAME,
                      SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
                      SIDEBAR_ROW_HOVER_CLASS_NAME,
                    )}
                    data-space-create-trigger
                  >
                    <SidebarLeadingIcon size="sm" tone="text-inherit">
                      <SidebarGlyph icon={AddPlusIcon} variant="leading" />
                    </SidebarLeadingIcon>
                    <span className="truncate">创建</span>
                  </button>
                }
              />
            </SidebarMenuItem>
            <NavRow
              icon={LayoutGridIcon}
              label="全部"
              active={isSection({ type: "all" })}
              onClick={() => props.onSection({ type: "all" })}
            />
            {KIND_ROWS.map((row) => (
              <NavRow
                key={row.kind}
                icon={row.icon}
                label={row.label}
                active={isSection({ type: "kind", kind: row.kind })}
                onClick={() => props.onSection({ type: "kind", kind: row.kind })}
              />
            ))}
          </SidebarMenu>
        </nav>

        {props.recent.length ? (
          <section className="mt-4" aria-label="最近">
            <h3 className={cn("flex h-7 items-center px-2.5", SIDEBAR_SECTION_LABEL_CLASS_NAME)}>
              最近
            </h3>
            <SidebarMenu className="gap-0.5">
              {props.recent.map((item) => {
                const meta = spaceItemMeta(item);
                const untitled = item.title.trim() === "";
                return (
                  <NavRow
                    key={item.key}
                    icon={meta.icon}
                    label={spaceItemDisplayTitle(item)}
                    // An untitled row also says when it was made, so two of them differ.
                    detail={untitled ? formatRelativeTime(item.updatedAt, Date.now()) : undefined}
                    active={props.openKey === item.key}
                    onClick={() => props.onOpen(item)}
                  />
                );
              })}
            </SidebarMenu>
          </section>
        ) : null}

        <section className="mt-4" aria-label="资料空间列表">
          <div className="flex h-7 items-center justify-between pr-0.5 pl-2.5">
            <h3 className={SIDEBAR_SECTION_LABEL_CLASS_NAME}>资料空间</h3>
            <SidebarIconButton
              icon={AddPlusIcon}
              label="新建资料空间"
              onClick={() => props.onCreate("space")}
            />
          </div>
          <div className={cn("flex flex-col", SIDEBAR_NESTED_LIST_GAP_CLASS_NAME)}>
            {props.spaces
              .filter((space) => space.trashedAt === null)
              .map((space) => {
                const children = livePages.filter((page) => page.parentPageId === space.rootPageId);
                const open = expanded.has(space.id);
                const active = isSection({ type: "space", spaceId: space.id });
                return (
                  <div
                    key={space.id}
                    className={cn("flex flex-col", SIDEBAR_NESTED_LIST_GAP_CLASS_NAME)}
                  >
                    <div
                      className={cn(
                        "group/space-row",
                        SIDEBAR_HEADER_ROW_CLASS_NAME,
                        "p-0 pe-1 ps-2",
                        active
                          ? SIDEBAR_ROW_ACTIVE_CLASS_NAME
                          : cn(SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME),
                      )}
                    >
                      <button
                        type="button"
                        className="group/space-icon relative flex size-5 shrink-0 items-center justify-center"
                        aria-label={`${open ? "收起" : "展开"} ${space.title}`}
                        aria-expanded={open}
                        onClick={() => toggle(space.id)}
                      >
                        <span className="group-hover/space-row:opacity-0">
                          {isKnownSpaceIcon(space.icon) ? (
                            <SpaceIcon icon={space.icon} />
                          ) : (
                            <FoldersIcon aria-hidden className="size-4" />
                          )}
                        </span>
                        <ChevronRightIcon
                          aria-hidden
                          className={cn(
                            "absolute size-3 opacity-0 transition-transform group-hover/space-row:opacity-100",
                            open && "rotate-90",
                          )}
                        />
                      </button>
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate py-1.5 text-left"
                        aria-current={active ? "page" : undefined}
                        onClick={() => props.onSection({ type: "space", spaceId: space.id })}
                      >
                        {space.title}
                      </button>
                      <span className="flex items-center opacity-0 group-hover/space-row:opacity-100 group-focus-within/space-row:opacity-100 has-[[data-popup-open]]:opacity-100">
                        <SpaceRowMenu
                          space={space}
                          scopeSpaceId={props.scopeSpaceId}
                          onRename={() => props.onRenameSpace(space)}
                          onIcon={(icon) => props.onSpaceIcon(space, icon)}
                          onTrash={() => props.onTrashSpace(space)}
                        />
                      </span>
                    </div>
                    <DisclosureRegion open={open}>
                      <div className={cn("flex flex-col", SIDEBAR_NESTED_LIST_GAP_CLASS_NAME)}>
                        {children.length ? (
                          children.map((page) => renderPage(page, 1, new Set()))
                        ) : (
                          <p className="py-1.5 ps-9 text-ui-sm text-muted-foreground">没有页面</p>
                        )}
                      </div>
                    </DisclosureRegion>
                  </div>
                );
              })}
          </div>
        </section>
      </div>
      <div className="border-t border-[color:var(--app-rail-inset-border,var(--border))] px-1.5 py-1.5">
        <SidebarMenu>
          <NavRow
            icon={TrashCanIcon}
            label="回收站"
            active={isSection({ type: "trash" })}
            onClick={() => props.onSection({ type: "trash" })}
          />
        </SidebarMenu>
      </div>
    </aside>
  );
}

/** One 资料空间 nav row: the main sidebar's primary action row, so both panels match. */
function NavRow(props: {
  icon: LucideIcon;
  label: string;
  /** Quiet text at the row's end (an untitled item's time). */
  detail?: string | undefined;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <SidebarPrimaryAction
      icon={props.icon}
      label={props.label}
      detail={props.detail}
      active={props.active}
      onClick={props.onClick}
    />
  );
}

function SpaceRowMenu(props: {
  space: PageSpace;
  scopeSpaceId: SpaceId | null;
  onRename: () => void;
  onIcon: (icon: string | null) => void;
  onTrash: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Menu onOpenChange={setOpen}>
      <SidebarIconButton
        render={<MenuTrigger />}
        icon={EllipsisIcon}
        label={`${props.space.title} 的操作`}
      />
      <ComposerPickerMenuPopup align="start" className="w-56 min-w-56">
        <MenuItem onClick={props.onRename}>重命名</MenuItem>
        <div className="px-1 pt-1 pb-0.5 text-ui-sm text-muted-foreground">图标</div>
        <div className="grid grid-cols-7 gap-0.5 px-1 pb-1" role="group" aria-label="资料空间图标">
          {SPACE_ICON_OPTIONS.map((option) => (
            <MenuItem
              key={option.name}
              aria-label={option.label}
              aria-checked={props.space.icon === option.name}
              className={cn(
                "flex size-7 justify-center p-0",
                props.space.icon === option.name && "bg-accent",
              )}
              onClick={() => props.onIcon(option.name)}
            >
              <SpaceIcon icon={option.name} />
            </MenuItem>
          ))}
        </div>
        {props.space.icon ? (
          <MenuItem onClick={() => props.onIcon(null)}>恢复默认图标</MenuItem>
        ) : null}
        <MenuSeparator />
        {open && <SpaceSyncMenuItem scopeSpaceId={props.scopeSpaceId} spaceId={props.space.id} />}
        <MenuItem variant="destructive" onClick={props.onTrash}>
          移到回收站
        </MenuItem>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

function sameSection(a: SpaceSection, b: SpaceSection): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "kind" && b.type === "kind") return a.kind === b.kind;
  if (a.type === "space" && b.type === "space") return a.spaceId === b.spaceId;
  return true;
}
