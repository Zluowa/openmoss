// FILE: SidebarSectionDialog.tsx
// Purpose: Shared authoritative section-creation dialog used by Sidebar and browser receipts.
// Layer: Web production component

import { SIDEBAR_SECTION_NAME_MAX_LENGTH } from "@synara/contracts";

import type { MossLocaleCode } from "../uiLocale";
import { sidebarSectionManagementCopy } from "./sidebarSectionManagement";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

export function SidebarSectionDialog(props: {
  readonly open: boolean;
  readonly locale: MossLocaleCode;
  readonly mode?: "create" | "edit";
  readonly name: string;
  readonly isSubmitting?: boolean;
  readonly validationMessage?: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onNameChange: (name: string) => void;
  readonly onCancel: () => void;
  readonly onSubmit: () => void | Promise<void>;
}) {
  const {
    isSubmitting = false,
    locale,
    mode: modeProp,
    name,
    onCancel,
    onNameChange,
    onOpenChange,
    onSubmit,
    open,
    validationMessage = null,
  } = props;
  const mode = modeProp ?? "create";
  const managementCopy = sidebarSectionManagementCopy(locale);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md" data-sidebar-section-dialog-mode={mode}>
        <DialogHeader>
          <DialogTitle>
            {mode === "edit" ? managementCopy.editSection : managementCopy.newSection}
          </DialogTitle>
          <DialogDescription>{managementCopy.groupDescription}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <label
            htmlFor="sidebar-section-name-input"
            className="mb-1.5 block text-ui-xs font-medium text-[var(--color-text-foreground-secondary)]"
          >
            {managementCopy.sectionName}
          </label>
          <Input
            id="sidebar-section-name-input"
            autoFocus
            value={name}
            maxLength={SIDEBAR_SECTION_NAME_MAX_LENGTH}
            disabled={isSubmitting}
            aria-invalid={validationMessage ? true : undefined}
            aria-describedby={validationMessage ? "sidebar-section-name-error" : undefined}
            onChange={(event) => onNameChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void onSubmit();
              }
            }}
          />
          {validationMessage ? (
            <p id="sidebar-section-name-error" role="alert" className="text-ui-sm text-destructive">
              {validationMessage}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={isSubmitting}>
            {managementCopy.cancel}
          </Button>
          <Button
            onClick={() => void onSubmit()}
            disabled={isSubmitting || name.trim().length === 0}
          >
            {isSubmitting
              ? managementCopy.saving
              : mode === "edit"
                ? managementCopy.save
                : managementCopy.createSection}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
