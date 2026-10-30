// FILE: sidebarSectionManagement.ts
// Purpose: Pure labels and ordering helpers for authoritative custom-section controls.
// Layer: Sidebar UI logic

import type { SidebarSectionId } from "@synara/contracts";

import { translateZhCnPresentationText } from "../localization/zhCN";
import type { MossLocaleCode } from "../uiLocale";

export type SidebarSectionManagementCopy = Readonly<{
  optionsFor: (sectionName: string) => string;
  newSection: string;
  editSection: string;
  archiveAllChats: string;
  deleteSection: string;
  sectionName: string;
  groupDescription: string;
  createSection: string;
  cancel: string;
  saving: string;
  save: string;
  unableToUpdateSection: string;
  appServerUnavailable: string;
  sectionChangeRejected: string;
  unableToConfirmArchive: string;
  archiveConfirmationFailed: string;
  sectionNameRequired: string;
  sectionNameTooLong: string;
  reorder: (sectionName: string) => string;
}>;

/**
 * Returns one production copy source for section-management labels. Dynamic section names
 * cannot use the presentation fallback map directly, so their accessible label is composed
 * here while the static fragments continue through the same fallback translator.
 */
export function sidebarSectionManagementCopy(locale: MossLocaleCode): SidebarSectionManagementCopy {
  const copy = (value: string) =>
    locale === "zh-CN" ? translateZhCnPresentationText(value) : value;

  return {
    optionsFor: (sectionName) =>
      locale === "zh-CN" ? `“${sectionName}”的选项` : `Options for ${sectionName}`,
    newSection: copy("New section"),
    editSection: copy("Edit section"),
    archiveAllChats: copy("Archive all chats"),
    deleteSection: copy("Delete section"),
    sectionName: copy("Section name"),
    groupDescription: copy("Group chats and projects however you like"),
    createSection: copy("Create section"),
    cancel: copy("Cancel"),
    saving: copy("Saving..."),
    save: copy("Save"),
    unableToUpdateSection: copy("Unable to update section"),
    appServerUnavailable: copy("The app server is unavailable."),
    sectionChangeRejected: copy("The section change was rejected."),
    unableToConfirmArchive: copy("Could not confirm archive"),
    archiveConfirmationFailed: copy("Unable to confirm the archive."),
    sectionNameRequired: copy("Section name is required."),
    sectionNameTooLong: copy("Section name is too long."),
    reorder: (sectionName) =>
      locale === "zh-CN" ? `重新排列“${sectionName}”` : `Reorder ${sectionName}`,
  };
}

/**
 * Computes the next complete section order for a dnd-kit active/over pair.
 * Invalid or same-target pairs return null so callers dispatch no command.
 */
export function reorderSidebarSectionIds(
  sectionIds: ReadonlyArray<SidebarSectionId>,
  draggedSectionId: SidebarSectionId,
  targetSectionId: SidebarSectionId,
): SidebarSectionId[] | null {
  if (draggedSectionId === targetSectionId) return null;

  const uniqueIds = new Set(sectionIds);
  if (
    uniqueIds.size !== sectionIds.length ||
    !uniqueIds.has(draggedSectionId) ||
    !uniqueIds.has(targetSectionId)
  ) {
    return null;
  }

  const nextIds = [...sectionIds];
  const draggedIndex = nextIds.indexOf(draggedSectionId);
  const targetIndex = nextIds.indexOf(targetSectionId);
  if (draggedIndex < 0 || targetIndex < 0) return null;

  nextIds.splice(draggedIndex, 1);
  nextIds.splice(targetIndex, 0, draggedSectionId);
  return nextIds;
}
