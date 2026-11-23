// FILE: pill-tabs.tsx
// Purpose: The old name of the shared tab strip. `Tabs` (tabs.tsx) is the one part; this alias
//          keeps the screens that import `PillTabs` compiling until they move to `Tabs`.
// Layer: Shared UI
// Exports: PillTabs, PillTab

export { Tabs as PillTabs, type TabItem as PillTab } from "./tabs";
