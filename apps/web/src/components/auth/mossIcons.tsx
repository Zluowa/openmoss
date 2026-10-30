// FILE: mossIcons.tsx
// Purpose: Icons used by Moss-owned surfaces (auth pages, membership, sidebar
//          account menu, shell tab chrome).
// Layer: Web UI utility
// Exports: LucideIcon-shaped icon components.
// Why: These used to be a second icon registry (Tabler wrappers plus a copy of the Central
//      adapter). Every glyph now comes from the one family in ~/lib/icons; this module only
//      keeps the import path stable for its consumers.

export {
  ArchiveTrayIcon,
  ArrowUpRightLineIcon,
  CirclePlusIcon,
  CompassLineIcon,
  ExpandArrowsIcon,
  GaugeIcon,
  LayoutWindowIcon,
  ListBulletsIcon,
  LogInIcon,
  LogOutIcon,
} from "~/lib/icons";
