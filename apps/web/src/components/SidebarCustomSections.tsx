// FILE: SidebarCustomSections.tsx
// Purpose: Renders authoritative custom sections, actions, and container ordering.
// Layer: Web production component

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragCancelEvent,
  type DragEndEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArchiveIcon, EllipsisIcon, NewThreadIcon, PencilIcon, Trash2 } from "~/lib/icons";
import {
  useCallback,
  Fragment,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactNode,
} from "react";
import type { OrchestrationSidebarSectionShell } from "@synara/contracts";
import type { ProjectId, SidebarSectionItemKey } from "@synara/contracts";

import { cn } from "~/lib/utils";
import type { MossLocaleCode } from "../uiLocale";
import type { SidebarSectionThreadTreeRow } from "./Sidebar.logic";
import type { SidebarThreadSummary } from "../types";
import {
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
  SIDEBAR_SECTION_LABEL_CLASS_NAME,
} from "../sidebarRowStyles";
import { reorderSidebarSectionIds, sidebarSectionManagementCopy } from "./sidebarSectionManagement";
import type { SidebarSectionArchivePlan } from "./sidebarSectionArchive";
import { SidebarIconButton } from "./SidebarIconButton";
import { SidebarSectionToolbar } from "./SidebarSectionToolbar";
import {
  SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME,
  SidebarContextMenuIcon,
} from "./sidebarContextMenuStyles";
import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import { DisclosureChevron } from "./ui/DisclosureChevron";
import { Menu, MenuGroup, MenuItem, MenuTrigger } from "./ui/menu";
import { DisclosureRegion } from "./ui/DisclosureRegion";
import { SidebarMenu, SidebarMenuButton, SidebarMenuSub } from "./ui/sidebar";
import {
  SidebarThreadPlacementDnd,
  type SidebarThreadPlacementHandler,
} from "./SidebarThreadPlacementDnd";
import {
  SidebarItemPlacementDnd,
  type SidebarItemPlacementHandler,
} from "./SidebarItemPlacementDnd";

const SECTION_TOOLBAR_RESERVE_CLASS_NAME =
  "pr-12 group-hover/project-header:pr-12 project-header-focus:pr-12";

type SidebarSectionId = OrchestrationSidebarSectionShell["id"];

type SidebarCustomSectionProps<T extends Pick<SidebarThreadSummary, "id" | "parentThreadId">> = {
  readonly locale: MossLocaleCode;
  readonly section: OrchestrationSidebarSectionShell;
  readonly rows: ReadonlyArray<SidebarSectionThreadTreeRow<T>>;
  readonly onToggle: (sectionId: SidebarSectionId, isCollapsed: boolean) => void;
  readonly onEdit: (section: OrchestrationSidebarSectionShell) => void;
  readonly onArchiveAll: (section: OrchestrationSidebarSectionShell) => void;
  readonly onDelete: (section: OrchestrationSidebarSectionShell) => void;
  readonly archivePlan?: SidebarSectionArchivePlan | undefined;
  readonly renderThread: (
    row: SidebarSectionThreadTreeRow<T>,
    section: OrchestrationSidebarSectionShell,
  ) => ReactNode;
  readonly emptyLabel: string;
  readonly suppressClickRef: MutableRefObject<boolean>;
  readonly threadPlacement?:
    | {
        readonly disabled?: boolean | undefined;
        readonly inFlight?: boolean | undefined;
        readonly onPlace: SidebarThreadPlacementHandler;
      }
    | undefined;
  readonly projectIds?: ReadonlyArray<ProjectId> | undefined;
  readonly renderProject?:
    | ((projectId: ProjectId, section: OrchestrationSidebarSectionShell) => ReactNode)
    | undefined;
  readonly projectPlacement?:
    | {
        readonly disabled?: boolean | undefined;
        readonly inFlight?: boolean | undefined;
        readonly onPlace: SidebarItemPlacementHandler;
      }
    | undefined;
  readonly onNewChat?: ((section: OrchestrationSidebarSectionShell) => void) | undefined;
};

function SortableSidebarCustomSection<
  T extends Pick<SidebarThreadSummary, "id" | "parentThreadId">,
>(props: SidebarCustomSectionProps<T>) {
  const {
    emptyLabel,
    locale,
    archivePlan,
    onArchiveAll,
    onDelete,
    onEdit,
    onToggle,
    renderThread,
    rows,
    section,
    suppressClickRef,
    threadPlacement,
    projectIds = [],
    renderProject,
    projectPlacement,
    onNewChat,
  } = props;
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    isDragging,
    isOver,
    transform,
    transition,
  } = useSortable({
    id: section.id,
    data: { type: "sidebar-section", sectionId: section.id },
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const [headerFocused, setHeaderFocused] = useState(false);
  const copy = sidebarSectionManagementCopy(locale);
  const archiveAllDisabled = (archivePlan?.rootGroups.length ?? 0) === 0;
  const explicitThreadIds = new Set(
    section.items
      .filter((item) => item.itemType === "thread" && item.key.startsWith("thread:"))
      .map((item) => item.key.slice("thread:".length)),
  );
  const placeableRows = rows.filter((row) => explicitThreadIds.has(String(row.thread.id)));
  const projectItemIds = new Set(projectIds);
  const orderedSectionItems = [
    ...section.items
      .filter((item) =>
        item.itemType === "project"
          ? projectItemIds.has(item.key.slice("project:".length) as ProjectId)
          : explicitThreadIds.has(item.key.slice("thread:".length)),
      )
      .toSorted(
        (left, right) => left.sortOrder - right.sortOrder || left.key.localeCompare(right.key),
      ),
    ...rows
      .filter((row) => !explicitThreadIds.has(String(row.thread.id)))
      .map((row, index) => ({
        key: `thread:${row.thread.id}` as SidebarSectionItemKey,
        itemType: "thread" as const,
        sortOrder: section.items.length + index,
      })),
  ];
  const emptyDropTarget = (
    <>
      {threadPlacement ? (
        <SidebarThreadPlacementDnd
          destination="custom"
          sectionId={section.id}
          sectionCreatedAt={section.createdAt}
          beforeThreadId={null}
          disabled={threadPlacement.disabled}
          inFlight={threadPlacement.inFlight}
          onPlace={threadPlacement.onPlace}
        >
          <div className="px-2 py-1 text-ui text-muted-foreground/48">{emptyLabel}</div>
        </SidebarThreadPlacementDnd>
      ) : (
        <div className="px-2 py-1 text-ui text-muted-foreground/48">{emptyLabel}</div>
      )}
      {projectPlacement ? (
        <SidebarItemPlacementDnd
          itemType="project"
          destination="custom"
          sectionId={section.id}
          sectionCreatedAt={section.createdAt}
          beforeItemKey={null}
          disabled={projectPlacement.disabled}
          inFlight={projectPlacement.inFlight}
          onPlace={projectPlacement.onPlace}
        >
          <div className="h-1" aria-label={`Drop project in ${section.name}`} />
        </SidebarItemPlacementDnd>
      ) : null}
    </>
  );
  const collapsedDropTarget =
    section.isCollapsed && orderedSectionItems.length > 0 ? (
      <>
        {threadPlacement ? (
          <SidebarThreadPlacementDnd
            destination="custom"
            sectionId={section.id}
            sectionCreatedAt={section.createdAt}
            beforeThreadId={null}
            disabled={threadPlacement.disabled}
            inFlight={threadPlacement.inFlight}
            onPlace={threadPlacement.onPlace}
          >
            <div className="h-2" aria-label={`Drop thread in ${section.name}`} />
          </SidebarThreadPlacementDnd>
        ) : null}
        {projectPlacement ? (
          <SidebarItemPlacementDnd
            itemType="project"
            destination="custom"
            sectionId={section.id}
            sectionCreatedAt={section.createdAt}
            beforeItemKey={null}
            disabled={projectPlacement.disabled}
            inFlight={projectPlacement.inFlight}
            onPlace={projectPlacement.onPlace}
          >
            <div className="h-2" aria-label={`Drop project in ${section.name}`} />
          </SidebarItemPlacementDnd>
        ) : null}
      </>
    ) : null;

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={cn(
        "group/collapsible relative rounded-md",
        isDragging ? "z-20 opacity-80" : null,
        isOver && !isDragging ? "ring-1 ring-primary/40" : null,
      )}
      data-sidebar-section-id={section.id}
      data-sidebar-section-dragging={isDragging ? "true" : undefined}
    >
      <div className="group/project-header relative">
        <SidebarMenu className="gap-0">
          <SidebarMenuButton
            {...listeners}
            size="sm"
            aria-expanded={!section.isCollapsed}
            className={cn(
              SIDEBAR_HEADER_ROW_CLASS_NAME,
              SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
              SIDEBAR_ROW_HOVER_CLASS_NAME,
              "cursor-grab active:cursor-grabbing",
            )}
            data-sidebar-section-drag-handle
            onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              onToggle(section.id, !section.isCollapsed);
            }}
            onFocus={() => setHeaderFocused(true)}
            onBlur={() => setHeaderFocused(false)}
            onPointerDownCapture={() => {
              suppressClickRef.current = false;
            }}
            onClick={(event) => {
              if (suppressClickRef.current) {
                suppressClickRef.current = false;
                event.preventDefault();
                event.stopPropagation();
                return;
              }
              onToggle(section.id, !section.isCollapsed);
            }}
          >
            <span
              className={cn(
                "flex min-w-0 flex-1 items-center gap-1 overflow-hidden transition-[padding] duration-150 ease-out",
                SECTION_TOOLBAR_RESERVE_CLASS_NAME,
              )}
            >
              <span
                className={cn("truncate", SIDEBAR_SECTION_LABEL_CLASS_NAME)}
                data-sidebar-section-name
              >
                {section.name}
              </span>
              <DisclosureChevron open={!section.isCollapsed} className="text-muted-foreground/79" />
            </span>
          </SidebarMenuButton>
          {onNewChat ? (
            <button
              type="button"
              className="absolute right-8 top-1/2 z-10 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground/70 opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/project-header:opacity-100"
              aria-label={`New chat in ${section.name}`}
              data-sidebar-section-new-chat
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onNewChat(section);
              }}
            >
              <NewThreadIcon className="size-3.5" />
            </button>
          ) : null}
          <button
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            type="button"
            className="sr-only"
            aria-label={copy.reorder(section.name)}
            data-sidebar-section-keyboard-drag-handle
          />
        </SidebarMenu>

        <Menu open={menuOpen} onOpenChange={setMenuOpen}>
          <SidebarSectionToolbar
            placement="overlay"
            revealOnHover
            forceVisible={headerFocused || menuOpen}
            className="max-md:pointer-events-auto"
          >
            <SidebarIconButton
              render={<MenuTrigger />}
              icon={EllipsisIcon}
              label={copy.optionsFor(section.name)}
              data-testid="sidebar-section-options"
              onFocus={() => setHeaderFocused(true)}
              onBlur={() => setHeaderFocused(false)}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            />
          </SidebarSectionToolbar>
          <ComposerPickerMenuPopup align="end" side="bottom" className="min-w-44">
            <MenuGroup>
              <MenuItem
                className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME}
                onClick={() => {
                  setMenuOpen(false);
                  onEdit(section);
                }}
              >
                <SidebarContextMenuIcon icon={PencilIcon} />
                <span>{copy.editSection}</span>
              </MenuItem>
              <MenuItem
                className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME}
                disabled={archiveAllDisabled}
                onClick={() => {
                  setMenuOpen(false);
                  onArchiveAll(section);
                }}
              >
                <SidebarContextMenuIcon icon={ArchiveIcon} />
                <span>{copy.archiveAllChats}</span>
              </MenuItem>
              <MenuItem
                variant="destructive"
                className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME}
                onClick={() => {
                  setMenuOpen(false);
                  onDelete(section);
                }}
              >
                <SidebarContextMenuIcon icon={Trash2} />
                <span>{copy.deleteSection}</span>
              </MenuItem>
            </MenuGroup>
          </ComposerPickerMenuPopup>
        </Menu>
      </div>

      {section.isCollapsed && orderedSectionItems.length === 0
        ? emptyDropTarget
        : collapsedDropTarget}
      <DisclosureRegion open={!section.isCollapsed} className="pt-0.5 duration-220">
        {orderedSectionItems.length > 0 ? (
          <>
            <SidebarMenu className="gap-1">
              <SidebarMenuSub className="mx-0 w-full border-0 px-0 py-0">
                {orderedSectionItems.map((item) => {
                  const itemThreadId =
                    item.itemType === "thread" ? item.key.slice("thread:".length) : null;
                  const row =
                    itemThreadId === null
                      ? undefined
                      : rows.find((candidate) => String(candidate.thread.id) === itemThreadId);
                  const placementIndex =
                    itemThreadId === null
                      ? -1
                      : placeableRows.findIndex(
                          (candidate) => candidate.thread.id === itemThreadId,
                        );
                  const canPlace =
                    threadPlacement !== undefined && placementIndex >= 0 && row !== undefined;
                  const previousThreadId = canPlace
                    ? (placeableRows[placementIndex - 1]?.thread.id ?? null)
                    : null;
                  const nextThreadId = canPlace
                    ? (placeableRows[placementIndex + 1]?.thread.id ?? null)
                    : null;
                  if (item.itemType === "project" && renderProject) {
                    const projectId = item.key.slice("project:".length) as ProjectId;
                    const projectNode = renderProject(projectId, section);
                    return (
                      <Fragment key={item.key}>
                        {projectPlacement ? (
                          <SidebarItemPlacementDnd
                            itemKey={item.key as SidebarSectionItemKey}
                            itemType="project"
                            destination="custom"
                            sectionId={section.id}
                            sectionCreatedAt={section.createdAt}
                            beforeItemKey={item.key as SidebarSectionItemKey}
                            disabled={projectPlacement.disabled}
                            inFlight={projectPlacement.inFlight}
                            onPlace={projectPlacement.onPlace}
                          >
                            {projectNode}
                          </SidebarItemPlacementDnd>
                        ) : (
                          projectNode
                        )}
                      </Fragment>
                    );
                  }
                  if (!row) return null;
                  return (
                    <span key={row.thread.id} className="contents">
                      <SidebarItemPlacementDnd
                        itemType="project"
                        destination="custom"
                        sectionId={section.id}
                        sectionCreatedAt={section.createdAt}
                        beforeItemKey={item.key as SidebarSectionItemKey}
                        disabled={projectPlacement?.disabled}
                        inFlight={projectPlacement?.inFlight}
                        onPlace={projectPlacement?.onPlace ?? (() => undefined)}
                      >
                        {canPlace ? (
                          <SidebarThreadPlacementDnd
                            threadId={row.thread.id}
                            destination="custom"
                            sectionId={section.id}
                            sectionCreatedAt={section.createdAt}
                            beforeThreadId={row.thread.id}
                            previousThreadId={previousThreadId}
                            nextThreadId={nextThreadId}
                            disabled={threadPlacement.disabled}
                            inFlight={threadPlacement.inFlight}
                            onPlace={threadPlacement.onPlace}
                          >
                            {renderThread(row, section)}
                          </SidebarThreadPlacementDnd>
                        ) : (
                          renderThread(row, section)
                        )}
                      </SidebarItemPlacementDnd>
                    </span>
                  );
                })}
              </SidebarMenuSub>
            </SidebarMenu>
            {threadPlacement ? (
              <SidebarThreadPlacementDnd
                destination="custom"
                sectionId={section.id}
                sectionCreatedAt={section.createdAt}
                beforeThreadId={null}
                disabled={threadPlacement.disabled}
                inFlight={threadPlacement.inFlight}
                onPlace={threadPlacement.onPlace}
              >
                <div className="h-1" aria-label={`Drop thread at end of ${section.name}`} />
              </SidebarThreadPlacementDnd>
            ) : null}
            {projectPlacement ? (
              <SidebarItemPlacementDnd
                itemType="project"
                destination="custom"
                sectionId={section.id}
                sectionCreatedAt={section.createdAt}
                beforeItemKey={null}
                disabled={projectPlacement.disabled}
                inFlight={projectPlacement.inFlight}
                onPlace={projectPlacement.onPlace}
              >
                <div className="h-1" aria-label={`Drop project at end of ${section.name}`} />
              </SidebarItemPlacementDnd>
            ) : null}
          </>
        ) : section.isCollapsed ? null : (
          emptyDropTarget
        )}
      </DisclosureRegion>
    </div>
  );
}

const sectionCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  return pointerCollisions.length > 0 ? pointerCollisions : closestCorners(args);
};

const sectionKeyboardCoordinates: KeyboardCoordinateGetter = (
  event,
  { active, currentCoordinates },
) => {
  if (event.code !== "ArrowDown" && event.code !== "ArrowUp") return;
  const sections =
    typeof document === "undefined"
      ? []
      : Array.from(document.querySelectorAll<HTMLElement>("[data-sidebar-section-id]"));
  const activeIndex = sections.findIndex(
    (section) => section.dataset.sidebarSectionId === String(active),
  );
  if (activeIndex < 0) return currentCoordinates;
  const nextIndex = activeIndex + (event.code === "ArrowDown" ? 1 : -1);
  const target = sections[nextIndex];
  if (!target) return currentCoordinates;
  const rect = target.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
};

export function SidebarCustomSections<
  T extends Pick<SidebarThreadSummary, "id" | "parentThreadId">,
>(props: {
  readonly sections: ReadonlyArray<OrchestrationSidebarSectionShell>;
  readonly sectionRowsById: ReadonlyMap<
    OrchestrationSidebarSectionShell["id"],
    ReadonlyArray<SidebarSectionThreadTreeRow<T>>
  >;
  readonly locale: MossLocaleCode;
  readonly onToggle: (
    sectionId: OrchestrationSidebarSectionShell["id"],
    isCollapsed: boolean,
  ) => void;
  readonly onEdit: (section: OrchestrationSidebarSectionShell) => void;
  readonly onArchiveAll: (section: OrchestrationSidebarSectionShell) => void;
  readonly onDelete: (section: OrchestrationSidebarSectionShell) => void;
  readonly sectionArchivePlanById: ReadonlyMap<
    OrchestrationSidebarSectionShell["id"],
    SidebarSectionArchivePlan
  >;
  readonly onReorder: (
    draggedSectionId: OrchestrationSidebarSectionShell["id"],
    orderedSectionIds: ReadonlyArray<OrchestrationSidebarSectionShell["id"]>,
  ) => void | Promise<void>;
  readonly renderThread: (
    row: SidebarSectionThreadTreeRow<T>,
    section: OrchestrationSidebarSectionShell,
  ) => ReactNode;
  readonly emptyLabel?: string;
  readonly threadPlacement?:
    | {
        readonly disabled?: boolean | undefined;
        readonly inFlight?: boolean | undefined;
        readonly onPlace: SidebarThreadPlacementHandler;
      }
    | undefined;
  readonly projectRowsById?:
    | ReadonlyMap<OrchestrationSidebarSectionShell["id"], ReadonlyArray<ProjectId>>
    | undefined;
  readonly renderProject?:
    | ((projectId: ProjectId, section: OrchestrationSidebarSectionShell) => ReactNode)
    | undefined;
  readonly projectPlacement?:
    | {
        readonly disabled?: boolean | undefined;
        readonly inFlight?: boolean | undefined;
        readonly onPlace: SidebarItemPlacementHandler;
      }
    | undefined;
  readonly onNewChat?: ((section: OrchestrationSidebarSectionShell) => void) | undefined;
  /** Use the Sidebar-owned context so section and thread drops share one sensor. */
  readonly sharedDndContext?: boolean;
}) {
  const {
    emptyLabel = "No threads in this section",
    locale,
    onArchiveAll,
    onDelete,
    onEdit,
    onReorder,
    onToggle,
    renderThread,
    sectionArchivePlanById,
    sectionRowsById,
    sections,
    sharedDndContext = false,
    threadPlacement,
    projectRowsById,
    renderProject,
    projectPlacement,
    onNewChat,
  } = props;
  const suppressClickRef = useRef(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sectionKeyboardCoordinates }),
  );
  const sectionIds = sections.map((section) => section.id);

  const releaseClickSuppression = useCallback(() => {
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  }, []);

  const handleDragStart = useCallback((_event: DragStartEvent) => {
    suppressClickRef.current = true;
  }, []);

  const handleDragCancel = useCallback(
    (_event: DragCancelEvent) => {
      releaseClickSuppression();
    },
    [releaseClickSuppression],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const draggedSection = sections.find((section) => section.id === String(event.active.id));
      const targetSection = event.over
        ? sections.find((section) => section.id === String(event.over?.id))
        : undefined;
      releaseClickSuppression();
      if (!draggedSection || !targetSection) return;
      const orderedSectionIds = reorderSidebarSectionIds(
        sectionIds,
        draggedSection.id,
        targetSection.id,
      );
      if (orderedSectionIds) {
        void onReorder(draggedSection.id, orderedSectionIds);
      }
    },
    [onReorder, releaseClickSuppression, sectionIds, sections],
  );

  if (sections.length === 0) return null;

  const sectionContent = (
    <SortableContext items={sectionIds} strategy={verticalListSortingStrategy}>
      <div className="flex flex-col gap-1" data-sidebar-custom-sections>
        {sections.map((section) => (
          <SortableSidebarCustomSection
            key={section.id}
            locale={locale}
            section={section}
            rows={sectionRowsById.get(section.id) ?? []}
            onToggle={onToggle}
            onEdit={onEdit}
            onArchiveAll={onArchiveAll}
            onDelete={onDelete}
            archivePlan={sectionArchivePlanById.get(section.id)}
            renderThread={renderThread}
            projectIds={projectRowsById?.get(section.id) ?? []}
            renderProject={renderProject}
            projectPlacement={projectPlacement}
            onNewChat={onNewChat}
            emptyLabel={emptyLabel}
            suppressClickRef={suppressClickRef}
            threadPlacement={threadPlacement}
          />
        ))}
      </div>
    </SortableContext>
  );
  if (sharedDndContext) return sectionContent;
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={sectionCollisionDetection}
      modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {sectionContent}
    </DndContext>
  );
}
