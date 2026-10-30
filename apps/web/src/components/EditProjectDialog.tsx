// FILE: EditProjectDialog.tsx
// Purpose: Codex-style edit-project dialog — prefilled name (folder icon inline),
//          the project's source folder as a chip, and the lifecycle's single
//          destructive action: a red "Remove local project" at the footer left.
//          The name field's leading cell still opens Moss's icon/color picker.
// Layer: UI component
// Exports: EditProjectDialog, EditProjectValue

import { useEffect, useId, useRef, useState } from "react";

import { useTranslation } from "~/localization";
import type { ProjectAppearance } from "~/lib/projectAppearance";
import { FolderIcon } from "~/lib/icons";
import { ProjectAppearancePicker } from "./ProjectAppearancePicker";
import { ProjectSidebarIcon } from "./ProjectSidebarIcon";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  PROJECT_DIALOG_FIELD_CONTROL_CLASS_NAME,
  dialogFieldLabelClassName,
} from "./ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { cn } from "~/lib/utils";

export interface EditProjectValue {
  /** Empty clears the local name, so the project shows its folder name again. */
  readonly name: string;
  readonly appearance: ProjectAppearance | null;
}

export interface EditProjectDialogProps {
  open: boolean;
  cwd: string;
  /** Placeholder for the name field: what the project is called with no local name. */
  folderName: string;
  initialValue: EditProjectValue;
  onOpenChange: (open: boolean) => void;
  onSave: (value: EditProjectValue) => void;
  /** Destructive footer action; the red button renders only when this is provided. */
  onRemove?: (() => void) | undefined;
}

export function EditProjectDialog({
  open,
  cwd,
  folderName,
  initialValue,
  onOpenChange,
  onSave,
  onRemove,
}: EditProjectDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("projectSetup.editProject.title")}</DialogTitle>
        </DialogHeader>
        {/* Field state lives below DialogPopup, which unmounts its children after the close
            transition, so each open seeds a fresh draft from initialValue. */}
        <EditProjectForm
          cwd={cwd}
          folderName={folderName}
          initialValue={initialValue}
          onOpenChange={onOpenChange}
          onSave={onSave}
          {...(onRemove ? { onRemove } : {})}
        />
      </DialogPopup>
    </Dialog>
  );
}

function EditProjectForm({
  cwd,
  folderName,
  initialValue,
  onOpenChange,
  onSave,
  onRemove,
}: Omit<EditProjectDialogProps, "open">) {
  const { t } = useTranslation();
  const [name, setName] = useState(initialValue.name);
  const [appearance, setAppearance] = useState(initialValue.appearance);
  const [pickerOpen, setPickerOpen] = useState(false);
  const nameInputId = useId();
  const sourceFolderLabelId = useId();
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Deferred a frame: the dialog moves focus itself on open. Matches RenameDialog.
    const frame = window.requestAnimationFrame(() => {
      const nameInput = document.getElementById(nameInputId);
      if (nameInput instanceof HTMLInputElement) {
        nameInput.focus();
        nameInput.select();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [nameInputId]);

  const save = () => {
    onSave({ name: name.trim(), appearance });
    onOpenChange(false);
  };

  return (
    <>
      <DialogPanel className="space-y-4">
        {/* The popup is a sibling of the form, not a child of the field: React bubbles
            portal events through the component tree, so inside InputGroupAddon every click
            on the picker's empty space reached the addon's handler and pulled focus into
            the name input. */}
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            {/* Same field as Add project's folder path: the glyph sits in a leading cell,
                here as the button that opens the picker. */}
            <InputGroup className={PROJECT_DIALOG_FIELD_CONTROL_CLASS_NAME}>
              {/* Rounded and clipped like the field: the button's hover / open fill would otherwise
                square off past the field's corners. */}
              <InputGroupAddon className="w-10 self-stretch overflow-hidden rounded-s-[inherit] border-e border-foreground/12 ps-0 has-[>button]:ms-0">
                <PopoverTrigger
                  render={
                    <button
                      type="button"
                      aria-label={t("projectSetup.editProject.chooseIcon")}
                      className="flex size-full cursor-pointer items-center justify-center rounded-s-[inherit] text-muted-foreground outline-hidden transition-colors hover:bg-foreground/5 focus-visible:bg-foreground/6 data-popup-open:bg-foreground/6"
                    />
                  }
                >
                  <span className="relative flex size-4 items-center justify-center">
                    <ProjectSidebarIcon cwd={cwd} expanded={false} appearance={appearance} />
                  </span>
                </PopoverTrigger>
              </InputGroupAddon>
              <InputGroupInput
                id={nameInputId}
                aria-label={t("projectSetup.editProject.name")}
                value={name}
                placeholder={folderName}
                onChange={(event) => setName(event.target.value)}
              />
            </InputGroup>
          </form>
          <PopoverPopup
            align="start"
            side="bottom"
            sideOffset={8}
            initialFocus={searchInputRef}
            // Opaque like the dialog it opens over: the frosted default lets the
            // dialog's own buttons show through the grid.
            className="w-[22.5rem] bg-popover"
          >
            <ProjectAppearancePicker
              value={appearance}
              searchInputRef={searchInputRef}
              onChange={setAppearance}
              onEmojiPicked={() => setPickerOpen(false)}
            />
          </PopoverPopup>
        </Popover>

        {/* Source folder: Moss projects are single-root, so the folder chip is
            read-only — removing the folder is the red button below. */}
        <div className="space-y-2">
          <span
            id={sourceFolderLabelId}
            className={cn("block", dialogFieldLabelClassName, "text-ui text-foreground")}
          >
            {t("projectSetup.createProject.sourceFolder")}
          </span>
          <div
            aria-labelledby={sourceFolderLabelId}
            className="rounded-xl border border-foreground/10 bg-foreground/[0.025] px-3.5 py-3"
          >
            <div className="flex items-center gap-2.5">
              <FolderIcon className="size-4 shrink-0 text-muted-foreground/70" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-ui" title={cwd}>
                {folderName}
              </span>
            </div>
          </div>
        </div>
      </DialogPanel>
      <DialogFooter>
        {onRemove ? (
          <Button variant="destructive-outline" size="sm" className="sm:me-auto" onClick={onRemove}>
            {t("projectSetup.editProject.removeLocal")}
          </Button>
        ) : null}
        <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
          {t("projectSetup.editProject.cancel")}
        </Button>
        <Button size="sm" onClick={save}>
          {t("projectSetup.editProject.save")}
        </Button>
      </DialogFooter>
    </>
  );
}
