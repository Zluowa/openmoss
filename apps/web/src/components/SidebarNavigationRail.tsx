// FILE: SidebarNavigationRail.tsx
// Purpose: Moss destination catalog, persistent rail, and Codex-shaped Explore navigation.
// Layer: Web shell navigation

import { useQuery } from "@tanstack/react-query";
import {
  serverMossAccountSessionQueryOptions,
  serverMossCloudAccountStateQueryOptions,
} from "~/components/auth/mossServerReactQuery";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import { useState, type ComponentType } from "react";

import { useDesktopUpdate } from "~/hooks/useDesktopUpdate";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { ArrowDownIcon, ArrowUpIcon, PinFilledIcon, PinIcon } from "~/lib/icons";
import { createCentralIconComponent } from "~/lib/central-icons";
import {
  closeMossCanvas,
  openMossCanvas,
  openMossLibraryDestination,
} from "~/lib/mossCanvasBridge";
import { parseMossSurface, withMossSurface } from "~/lib/mossSurfaceState";

import { cn } from "~/lib/utils";
// ---------------------------------------------------------------------------
// Moss destination catalog and rail ordering. These lived in
// ~/sidebarNavOrdering before the upstream merge; upstream rewrote that module
// around its own nav items, so the Moss-owned catalog stays with its only
// consumer here. Semantics are unchanged from the frozen Codex rail behavior.
// ---------------------------------------------------------------------------

/**
 * Moss destinations that have a real route or a native surface in this shell.
 *
 * This intentionally omits Finances and product-mode destinations. They exist in
 * the frozen Codex catalog, but Moss has no corresponding capability and must not
 * manufacture an entry for them. The order follows the observed desktop catalog;
 * the fixed rail shell owns Home/History/Mentions/More/Help/Profile.
 */
export const MOSS_DESTINATION_IDS = [
  "images",
  "pullRequests",
  "library",
  "automations",
  "skills",
] as const;

export type MossDestinationId = (typeof MOSS_DESTINATION_IDS)[number];

export type MossDestinationPath = "/pull-requests" | "/automations" | "/skills";

export type MossDestinationCatalogItem = {
  readonly id: MossDestinationId;
  readonly label: string;
  /** Images and Library use native surface bridges instead of invented routes. */
  readonly path?: MossDestinationPath;
  readonly visibleByDefault: boolean;
};

/**
 * Typed Moss adaptation of Codex's `rJi` destination catalog. `visibleByDefault`
 * values are retained from the observed catalog, including entries that Moss
 * keeps behind More through an explicit unpin override below.
 */
export const MOSS_DESTINATION_CATALOG: readonly MossDestinationCatalogItem[] = [
  { id: "images", label: "Images", visibleByDefault: true },
  {
    id: "pullRequests",
    label: "Pull requests",
    path: "/pull-requests",
    visibleByDefault: true,
  },
  { id: "library", label: "Library", visibleByDefault: true },
  { id: "automations", label: "Scheduled", path: "/automations", visibleByDefault: true },
  { id: "skills", label: "Plugins", path: "/skills", visibleByDefault: true },
] as const;

export const DEFAULT_MOSS_DESTINATION_ORDER: readonly MossDestinationId[] =
  MOSS_DESTINATION_CATALOG.map(({ id }) => id);

/** The observed A$t pin fill limit from Codex 26.924.22138. */
export const MAX_DIRECT_DESTINATIONS = 8;

/**
 * The shell has fixed rail slots for Images, Library and Scheduled. Pull
 * requests and Skills remain discoverable in More until a user pins them. An
 * explicit false is significant: A$t only fills visible-by-default entries when
 * the account has no visibility override for that entry.
 */
export const DEFAULT_MOSS_DESTINATION_PIN_OVERRIDES: Readonly<
  Partial<Record<MossDestinationId, boolean>>
> = {
  images: true,
  library: true,
  pullRequests: false,
  automations: true,
  // Plugins is opened from Explore in Codex. It is not a fixed rail slot.
  skills: false,
};

export type MossDestinationPartition = {
  readonly directDestinationIds: MossDestinationId[];
  readonly moreDestinationIds: MossDestinationId[];
};

export type MossDestinationPartitionOptions = {
  readonly eligibleDestinations?: ReadonlyArray<MossDestinationCatalogItem>;
  readonly order?: ReadonlyArray<string>;
  readonly pinOverrides?: Readonly<Record<string, boolean>>;
  readonly maxDirectDestinations?: number;
};

const MOSS_DESTINATION_ID_SET: ReadonlySet<MossDestinationId> = new Set(MOSS_DESTINATION_IDS);

export function isMossDestinationId(value: string): value is MossDestinationId {
  return MOSS_DESTINATION_ID_SET.has(value as MossDestinationId);
}

/**
 * Equivalent to Codex's M$t/j$t ordering pass: known persisted IDs retain their
 * order and omitted eligible IDs are inserted at their catalog position.
 */
export function normalizeMossDestinationOrder(
  order: ReadonlyArray<string> = DEFAULT_MOSS_DESTINATION_ORDER,
  eligibleDestinations: ReadonlyArray<MossDestinationCatalogItem> = MOSS_DESTINATION_CATALOG,
): MossDestinationId[] {
  const eligibleIds = new Set(eligibleDestinations.map(({ id }) => id));
  const seen = new Set<MossDestinationId>();
  const result: MossDestinationId[] = [];

  for (const candidate of order) {
    if (isMossDestinationId(candidate) && eligibleIds.has(candidate) && !seen.has(candidate)) {
      seen.add(candidate);
      result.push(candidate);
    }
  }

  for (const [catalogIndex, { id }] of eligibleDestinations.entries()) {
    if (!seen.has(id)) {
      seen.add(id);
      result.splice(Math.min(catalogIndex, result.length), 0, id);
    }
  }

  return result;
}

/**
 * Partition a catalog into direct and More destinations using the observed
 * E$t/A$t rule. Explicitly pinned IDs win first; visible-by-default entries fill
 * the remaining direct slots; every other eligible ID is returned in More.
 */
export function partitionMossDestinations({
  eligibleDestinations = MOSS_DESTINATION_CATALOG,
  order = DEFAULT_MOSS_DESTINATION_ORDER,
  pinOverrides = {},
  maxDirectDestinations = MAX_DIRECT_DESTINATIONS,
}: MossDestinationPartitionOptions = {}): MossDestinationPartition {
  const eligible = eligibleDestinations.filter(({ id }) => isMossDestinationId(id));
  const eligibleIds = new Set(eligible.map(({ id }) => id));
  const normalizedOrder = normalizeMossDestinationOrder(order, eligible);
  const directSet = new Set<MossDestinationId>();
  const limit = Math.min(MAX_DIRECT_DESTINATIONS, Math.max(0, Math.floor(maxDirectDestinations)));
  const pinnedSet = new Set<MossDestinationId>(
    Object.keys(pinOverrides).filter(
      (id): id is MossDestinationId =>
        isMossDestinationId(id) && eligibleIds.has(id) && pinOverrides[id] === true,
    ),
  );

  // A$t decides membership; E$t emits IDs in the persisted catalog order. Keep
  // those two steps separate so a pin override never reorders the rail by itself.
  for (const id of normalizedOrder) {
    if (directSet.size >= limit) break;
    if (pinnedSet.has(id)) {
      directSet.add(id);
    }
  }

  // Fill remaining direct slots from visibleByDefault entries with no explicit
  // visibility override, matching A$t's `e[r] == null` check.
  for (const destination of eligible) {
    if (directSet.size >= limit) break;
    if (!destination.visibleByDefault || pinOverrides[destination.id] !== undefined) continue;
    if (!directSet.has(destination.id)) {
      directSet.add(destination.id);
    }
  }

  const more = normalizedOrder.filter((id) => !directSet.has(id));
  return {
    directDestinationIds: normalizedOrder.filter((id) => directSet.has(id)),
    moreDestinationIds: more,
  };
}

/**
 * Fixed Moss destination rail order. The shell keeps Home/History/Library/
 * Images/Mentions/More so destinations retain the same muscle memory across
 * surfaces.
 */
export const SIDEBAR_RAIL_ITEM_IDS = [
  "home",
  "history",
  "library",
  "images",
  "mentions",
  "more",
  "scheduled",
  "help",
  "profile",
] as const;

export type SidebarRailItemId = (typeof SIDEBAR_RAIL_ITEM_IDS)[number];

import { Menu, MenuGroup, MenuItem, MenuPopupBase, MenuSeparator, MenuTrigger } from "./ui/menu";
import { useSidebar } from "./ui/sidebar";
import { RailAccountMenu } from "./SidebarAccountMenu";
import { SidebarThemeSkinSwitcher } from "./SidebarThemeSkinSwitcher";

type RailIcon = ComponentType<{ className?: string }>;
export type MossRailDestinationId = SidebarRailItemId | MossDestinationId;

type MossRailDestination = {
  readonly id: MossRailDestinationId;
  readonly label: string;
  readonly railIcons: { readonly default: RailIcon; readonly selected: RailIcon };
  readonly visibleByDefault: boolean;
  readonly hasUnreadActivity: boolean;
  readonly isCurrentDestination: boolean;
  readonly onSelect: () => void;
};

// Unified rail icon set: every destination glyph comes from the same Central
// family (24px grid, 1.5px stroke) and stays OUTLINE in both rest and selected
// states — selection is expressed by the chip background highlight, so the row
// never mixes filled and outline glyphs.
const ImagesIcon = createCentralIconComponent("images-3");
const BooksIcon = createCentralIconComponent("books");
const AtIcon = createCentralIconComponent("at");
const HomeOutlineIcon = createCentralIconComponent("home");
const HistoryOutlineIcon = createCentralIconComponent("history");
const CompassIcon = createCentralIconComponent("compass-round");
const PullRequestOutlineIcon = createCentralIconComponent("pull-request");
const CalendarClockIcon = createCentralIconComponent("calendar-clock");
const PuzzleIcon = createCentralIconComponent("puzzle");
const ArrowDownLineIcon = createCentralIconComponent("arrow-down");
const CATALOG_ICONS: Readonly<Record<MossDestinationId, MossRailDestination["railIcons"]>> = {
  images: { default: ImagesIcon, selected: ImagesIcon },
  library: { default: BooksIcon, selected: BooksIcon },
  pullRequests: { default: PullRequestOutlineIcon, selected: PullRequestOutlineIcon },
  automations: { default: CalendarClockIcon, selected: CalendarClockIcon },
  skills: { default: PuzzleIcon, selected: PuzzleIcon },
};

const DestinationPreferences = Schema.Struct({
  order: Schema.Array(Schema.String),
  pinOverrides: Schema.Record(Schema.String, Schema.Boolean),
});
const PreferencesByAccount = Schema.Record(Schema.String, DestinationPreferences);
const EMPTY_PREFERENCES: typeof PreferencesByAccount.Type = {};
/** Codex 26.924 rail geometry. Keep these values in one place so destination
 * hosts cannot slowly drift from the shell when the rail is reused. */
const RAIL_WIDTH_CLASS = "w-[3.25rem]";
const RAIL_TOP_INSET_CLASS = "h-[46px]";
const RAIL_BUTTON_CLASS =
  "group/rail-item flex size-10 shrink-0 items-center justify-center rounded-control text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/70";

function destinationMatchesPath(
  pathname: string,
  id: MossRailDestinationId,
  search?: Readonly<Record<string, unknown>>,
): boolean {
  if (id === "images") {
    return (
      pathname === "/images" || pathname.startsWith("/images/") || search?.mossSurface === "images"
    );
  }
  if (id === "library" && search?.mossSurface === "library") return true;
  const path = MOSS_DESTINATION_CATALOG.find((item) => item.id === id)?.path;
  if (path) return pathname === path || pathname.startsWith(`${path}/`);
  if (id === "help") return pathname === "/settings";
  if (id === "profile") return pathname === "/account";
  return false;
}

function RailDestinationIcon({
  destination,
  highlighted,
}: {
  readonly destination: MossRailDestination;
  readonly highlighted?: boolean;
}) {
  const isHighlighted = highlighted ?? destination.isCurrentDestination;
  const Icon = destination.isCurrentDestination
    ? destination.railIcons.selected
    : destination.railIcons.default;
  return (
    <span
      className={cn(
        "flex size-9 items-center justify-center rounded-control transition-colors",
        isHighlighted
          ? "bg-[#e9e9eb] text-[#1f1f1f] dark:bg-[#2d2d2f] dark:text-[#f4f4f5] [:where(html[data-moss-dest-theme=dark])_&]:bg-[#2d2d2f] [:where(html[data-moss-dest-theme=dark])_&]:text-[#f4f4f5]"
          : "group-hover/rail-item:bg-black/[0.06] dark:group-hover/rail-item:bg-white/[0.08] [:where(html[data-moss-dest-theme=dark])_&]:group-hover/rail-item:bg-white/[0.08]",
      )}
    >
      <Icon className="size-5" />
    </span>
  );
}

function RailDestinationButton({ destination }: { readonly destination: MossRailDestination }) {
  return (
    <button
      type="button"
      aria-label={destination.label}
      aria-current={destination.isCurrentDestination ? "page" : undefined}
      data-sidebar-rail-item={destination.id === "automations" ? "scheduled" : destination.id}
      data-state={destination.isCurrentDestination ? "active" : "inactive"}
      className={RAIL_BUTTON_CLASS}
      onClick={destination.onSelect}
      title={destination.label}
    >
      <RailDestinationIcon destination={destination} />
    </button>
  );
}

/**
 * The Codex slot directly above the rail avatar: it carries the update affordance
 * whenever an update exists, and the theme-skin switcher the rest of the time
 * (the download button only appears while an update is available).
 */
function RailUpdateThemeSlot() {
  const {
    showDesktopUpdateButton,
    desktopUpdateTooltip,
    desktopUpdateButtonDisabled,
    desktopUpdateDownloadPercent,
    handleDesktopUpdateButtonClick,
  } = useDesktopUpdate();

  if (showDesktopUpdateButton) {
    return (
      <button
        type="button"
        aria-label={desktopUpdateTooltip}
        title={desktopUpdateTooltip}
        disabled={desktopUpdateButtonDisabled}
        data-sidebar-rail-item="desktop-update"
        className={cn(
          RAIL_BUTTON_CLASS,
          "relative bg-[var(--info)] text-white hover:text-white disabled:cursor-not-allowed disabled:opacity-60",
        )}
        onClick={handleDesktopUpdateButtonClick}
      >
        <ArrowDownLineIcon className="size-[18px]" />
        {desktopUpdateDownloadPercent !== null ? (
          <span className="absolute -bottom-1 rounded-full bg-[var(--info)] px-1 text-[8px] font-semibold leading-3 text-white tabular-nums">
            {desktopUpdateDownloadPercent}%
          </span>
        ) : null}
      </button>
    );
  }

  return (
    <div
      className="flex size-10 shrink-0 items-center justify-center [&_.moss-theme-skin-trigger]:size-10 [&_.moss-theme-skin-trigger]:rounded-control [&_.moss-theme-skin-trigger]:text-muted-foreground [&_.moss-theme-skin-trigger:hover]:text-foreground"
      data-sidebar-rail-item="theme-skin"
    >
      <SidebarThemeSkinSwitcher />
    </div>
  );
}

/** Persistent 52px rail beside the independent conversation panel. */
export function SidebarNavigationRail() {
  const { isMobile, setOpen, setOpenMobile } = useSidebar();
  const navigate = useNavigate();
  const location = useLocation({
    select: (current) => ({
      pathname: current.pathname,
      search: current.search as Readonly<Record<string, unknown>>,
    }),
  });
  const { pathname } = location;
  const phoneAccount = useQuery(serverMossAccountSessionQueryOptions());
  const cloudAccount = useQuery(serverMossCloudAccountStateQueryOptions());
  const accountKey = phoneAccount.data?.authenticated
    ? `phone:${phoneAccount.data.session?.user.id ?? "anonymous"}`
    : cloudAccount.data?.authenticated
      ? `cloud:${cloudAccount.data.account?.id ?? "anonymous"}`
      : "anonymous";
  const [preferencesByAccount, setPreferencesByAccount] = useLocalStorage(
    "moss:sidebar-destinations:v1",
    EMPTY_PREFERENCES,
    PreferencesByAccount,
  );
  const preferences = preferencesByAccount[accountKey];
  const order = normalizeMossDestinationOrder(preferences?.order ?? DEFAULT_MOSS_DESTINATION_ORDER);
  // Images, Library, and Scheduled are fixed Moss rail slots. Keep legacy or
  // stale account preferences from removing those required destinations.
  const pinOverrides = {
    ...DEFAULT_MOSS_DESTINATION_PIN_OVERRIDES,
    ...(preferences?.pinOverrides ?? {}),
    images: true,
    library: true,
    automations: true,
  };
  const { directDestinationIds, moreDestinationIds } = partitionMossDestinations({
    order,
    pinOverrides,
  });
  const [selection, setSelection] = useState<{
    readonly id: MossRailDestinationId;
    readonly pathname: string;
    readonly surface: string | null;
  } | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const currentSurface = parseMossSurface(location.search);
  const selectedId =
    selection?.pathname === pathname && selection.surface === currentSurface
      ? selection.id
      : (MOSS_DESTINATION_CATALOG.find(({ id }) =>
          destinationMatchesPath(pathname, id, location.search),
        )?.id ??
        (pathname === "/settings" ? "help" : pathname === "/account" ? "profile" : "home"));
  const moreSelected = moreDestinationIds.some((id) => id === selectedId);

  const updatePreferences = (
    nextOrder: readonly string[],
    nextPins: Readonly<Record<string, boolean>>,
  ) => {
    setPreferencesByAccount((previous) => ({
      ...previous,
      [accountKey]: { order: [...nextOrder], pinOverrides: { ...nextPins } },
    }));
  };
  const togglePin = (id: MossDestinationId) => {
    if (id === "images" || id === "library" || id === "automations") return;
    const pinned = directDestinationIds.includes(id);
    if (!pinned && directDestinationIds.length >= MAX_DIRECT_DESTINATIONS) return;
    updatePreferences(order, { ...pinOverrides, [id]: !pinned });
  };
  const movePin = (id: MossDestinationId, direction: -1 | 1) => {
    const index = directDestinationIds.indexOf(id);
    const neighbor = directDestinationIds[index + direction];
    if (!neighbor) return;
    const nextOrder = [...order];
    const from = nextOrder.indexOf(id);
    const to = nextOrder.indexOf(neighbor);
    nextOrder[from] = neighbor;
    nextOrder[to] = id;
    updatePreferences(nextOrder, pinOverrides);
  };
  const selectDestination = (id: MossRailDestinationId) => {
    setSelection({ id, pathname, surface: currentSurface });
    setMoreOpen(false);
    if (id === "images") {
      // Helios PIVOT: Images → Codex-style Moss prompt-to-image workspace (not Canvas host).
      openMossCanvas({ surface: "images" });
      return;
    }
    if (id === "library") {
      // 资料库 destination (MossLibrarySurface) — distinct from Canvas assets.
      openMossLibraryDestination();
      return;
    }
    // Leave Library / Images overlays when switching to any other destination.
    closeMossCanvas("destination-switch");
    const clearSurfaceSearch = <T extends object>(previous: T) => withMossSurface(previous, null);
    if (id === "home") {
      void navigate({ to: "/", search: clearSurfaceSearch });
    } else if (id === "history") {
      // History is the chat surface with the conversation list open: land on home
      // like Codex's clock destination, then make sure the list is visible.
      void navigate({ to: "/", search: clearSurfaceSearch, replace: true });
      if (isMobile) setOpenMobile(true);
      else setOpen(true);
    } else if (id === "help") {
      void navigate({
        to: "/settings",
        search: (previous) => ({ ...clearSurfaceSearch(previous), section: "shortcuts" }),
      });
    } else if (id === "profile") {
      void navigate({ to: "/account", search: clearSurfaceSearch });
    } else if (id === "mentions") {
      void navigate({ to: ".", search: clearSurfaceSearch, replace: true });
      window.dispatchEvent(
        new CustomEvent(`moss-${id}-open`, { detail: { source: "moss-sidebar-rail" } }),
      );
    } else {
      const path = MOSS_DESTINATION_CATALOG.find((destination) => destination.id === id)?.path;
      if (path) void navigate({ to: path, search: clearSurfaceSearch });
    }
  };
  const catalog: readonly MossRailDestination[] = MOSS_DESTINATION_CATALOG.map((item) => ({
    ...item,
    railIcons: CATALOG_ICONS[item.id],
    hasUnreadActivity: false,
    isCurrentDestination: selectedId === item.id,
    onSelect: () => selectDestination(item.id),
  }));
  const fixedDestination = (
    id: SidebarRailItemId,
    label: string,
    icon: RailIcon,
    selectedIcon = icon,
  ): MossRailDestination => ({
    id,
    label,
    railIcons: { default: icon, selected: selectedIcon },
    visibleByDefault: true,
    hasUnreadActivity: false,
    isCurrentDestination: id === "more" ? moreSelected : selectedId === id,
    onSelect: () => selectDestination(id),
  });
  const more = fixedDestination("more", "Explore", CompassIcon);
  const mentions = fixedDestination("mentions", "Mentions", AtIcon);
  const top = [
    fixedDestination("home", "Home", HomeOutlineIcon),
    fixedDestination("history", "History", HistoryOutlineIcon),
    ...["library", "images", "automations"].flatMap((id) =>
      catalog.filter((item) => item.id === id),
    ),
  ];
  const direct = directDestinationIds.flatMap((id) =>
    id === "images" || id === "library" || id === "automations"
      ? []
      : catalog.filter((item) => item.id === id),
  );
  const explore = moreDestinationIds.flatMap((id) => catalog.filter((item) => item.id === id));

  return (
    <nav
      aria-label="Moss navigation rail"
      data-sidebar-rail-brand="Moss"
      data-sidebar-rail
      data-app-navigation-rail
      className={cn(
        "z-20 flex h-svh shrink-0 flex-col items-center border-r border-sidebar-border/60 bg-sidebar pb-3 text-sidebar-foreground [:where(html[data-moss-dest-theme=dark])_&]:border-white/10 [:where(html[data-moss-dest-theme=dark])_&]:bg-[#000000] [:where(html[data-moss-dest-theme=dark])_&]:text-[#E8E8E8]",
        RAIL_WIDTH_CLASS,
      )}
    >
      <div
        className={cn(RAIL_TOP_INSET_CLASS, "shrink-0")}
        data-moss-rail-top-inset
        aria-hidden="true"
      />
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto">
        <div className="flex flex-col items-center gap-0.5">
          {top.map((destination) => (
            <RailDestinationButton key={destination.id} destination={destination} />
          ))}
          <RailDestinationButton destination={mentions} />
          <Menu open={moreOpen} onOpenChange={setMoreOpen}>
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label="Explore"
                  aria-haspopup="menu"
                  aria-expanded={moreOpen}
                  aria-current={moreSelected ? "page" : undefined}
                  data-sidebar-rail-item="more"
                  data-state={moreSelected ? "active" : "inactive"}
                  className={RAIL_BUTTON_CLASS}
                  title="Explore"
                />
              }
            >
              <RailDestinationIcon destination={more} highlighted={moreSelected || moreOpen} />
            </MenuTrigger>
            <MenuPopupBase
              side="right"
              align="start"
              sideOffset={8}
              surface="composer"
              className="min-w-60"
              aria-label="Explore destinations"
            >
              <MenuGroup>
                <div className="px-2 py-1 text-ui-sm font-medium text-muted-foreground">
                  Explore
                </div>
                {explore.map((destination) => {
                  const id = destination.id as MossDestinationId;
                  const pinned = directDestinationIds.includes(id);
                  const Icon = destination.railIcons.default;
                  const Pin = pinned ? PinFilledIcon : PinIcon;
                  return (
                    <div
                      key={id}
                      className="group/explore-row flex items-center"
                      data-explore-row={id}
                    >
                      <MenuItem
                        className="flex-1"
                        onClick={destination.onSelect}
                        aria-current={destination.isCurrentDestination ? "page" : undefined}
                      >
                        <Icon className="size-4" />
                        {destination.label}
                      </MenuItem>
                      <MenuItem
                        closeOnClick={false}
                        className="shrink-0 px-2"
                        aria-label={`${pinned ? "Unpin" : "Pin"} ${destination.label}`}
                        title={pinned ? "Unpin from sidebar" : "Pin to sidebar"}
                        disabled={!pinned && directDestinationIds.length >= MAX_DIRECT_DESTINATIONS}
                        onClick={() => togglePin(id)}
                      >
                        <Pin className="size-4" />
                      </MenuItem>
                    </div>
                  );
                })}
              </MenuGroup>
              {direct.length > 1 && (
                <>
                  <MenuSeparator />
                  <MenuGroup>
                    <div className="px-2 py-1 text-ui-sm font-medium text-muted-foreground">
                      Reorder pins
                    </div>
                    {direct.map((destination) => {
                      const id = destination.id as MossDestinationId;
                      const index = directDestinationIds.indexOf(id);
                      return (
                        <div key={id} className="flex items-center px-2 text-ui-lg">
                          <span className="flex-1">{destination.label}</span>
                          <MenuItem
                            closeOnClick={false}
                            disabled={index === 0}
                            className="px-2"
                            aria-label={`Move ${destination.label} up`}
                            onClick={() => movePin(id, -1)}
                          >
                            <ArrowUpIcon className="size-4" />
                          </MenuItem>
                          <MenuItem
                            closeOnClick={false}
                            disabled={index === directDestinationIds.length - 1}
                            className="px-2"
                            aria-label={`Move ${destination.label} down`}
                            onClick={() => movePin(id, 1)}
                          >
                            <ArrowDownIcon className="size-4" />
                          </MenuItem>
                        </div>
                      );
                    })}
                  </MenuGroup>
                </>
              )}
            </MenuPopupBase>
          </Menu>
        </div>
        {direct.length > 0 && (
          <div className="my-2 h-px w-7 shrink-0 bg-sidebar-border/70" aria-hidden="true" />
        )}
        {direct.map((destination) => (
          <RailDestinationButton key={destination.id} destination={destination} />
        ))}
      </div>
      <div className="mt-auto flex shrink-0 flex-col items-center gap-0.5">
        {/* Codex has no rail help slot; settings/shortcuts live behind the account menu. */}
        <RailUpdateThemeSlot />
        {/* Codex opens the account menu from the rail avatar instead of navigating
            to a profile page; the menu content is shared with the account footer. */}
        <RailAccountMenu />
      </div>
    </nav>
  );
}
