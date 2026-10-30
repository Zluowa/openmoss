// FILE: CreateProjectDialog.tsx
// Purpose: Codex-style create-project dialog — project name (folder icon inline)
//          plus a source folder chosen through the native picker and shown as a
//          removable chip. No GitHub tab and no Space picker per the Codex flow
//          spec: the project lands in the currently active Space.
// Layer: Web UI dialog
// Exports: CreateProjectDialog, CreateProjectSubmitValue, CreateProjectSubmitOptions

import { type SpaceId } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { isElectron } from "../env";
import { useWindowFolderDrop } from "../hooks/useWindowFolderDrop";
import { readNativeApi } from "../nativeApi";
import { useTranslation } from "../localization";
import { serverEnvironmentQueryOptions } from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";

import { DeviceLaptopIcon, FolderAddIcon, FolderIcon, PlusIcon, XIcon } from "~/lib/icons";
import { describeAddProjectError } from "./Sidebar.logic";
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
import { ComposerPickerSelectPopup } from "./chat/ComposerPickerMenuPopup";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

interface CreateLocalProjectSubmitValue {
  readonly source: "local";
  readonly workspaceRoot: string;
  /** Optional display name chosen in the dialog; the folder name is used when omitted. */
  readonly name?: string;
  /** Extra source folders of a multi-folder project; `workspaceRoot` is the primary one.
      The Codex-form dialog never sets this today; the sidebar submit path accepts it. */
  readonly additionalFolders?: ReadonlyArray<string> | undefined;
  /** Destination Space; `null` is Void (unassigned). Always the active Space. */
  readonly spaceId: SpaceId | null;
  /** True when the path was typed by hand, so a missing folder may be created. */
  readonly createIfMissing: boolean;
}

interface CreateGitHubProjectSubmitValue {
  readonly source: "github";
  readonly operationId: string;
  readonly repository: string;
  readonly destinationParent: string;
  readonly directoryName: string;
  readonly spaceId: SpaceId | null;
}

// The GitHub variant stays in the union because the sidebar's submit handler still
// knows how to provision GitHub projects; this dialog no longer emits it.
export type CreateProjectSubmitValue =
  | CreateLocalProjectSubmitValue
  | CreateGitHubProjectSubmitValue;

export interface CreateProjectSubmitOptions {
  readonly signal: AbortSignal;
}

export function CreateProjectDialog(props: {
  open: boolean;
  activeSpaceId: SpaceId | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (value: CreateProjectSubmitValue, options: CreateProjectSubmitOptions) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [folderPath, setFolderPath] = useState("");
  /**
   * The last path delivered verbatim by the native picker or an OS drop. Those
   * folders exist by construction, so only hand-typed paths opt into
   * create-if-missing — and only picked folders render as a chip.
   */
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const openedRef = useRef(false);
  const submitAbortRef = useRef<AbortController | null>(null);
  const fieldId = useId();
  const nameInputId = `${fieldId}-name`;
  const pathInputId = `${fieldId}-path`;
  const submitButtonId = `${fieldId}-submit`;
  const sourceFolderLabelId = `${fieldId}-source-folder`;
  const errorId = `${fieldId}-error`;

  useEffect(() => {
    // Seed on the closed -> open transition only.
    if (props.open === openedRef.current) return;
    openedRef.current = props.open;
    if (!props.open) return;
    setName("");
    setFolderPath("");
    setPickedPath(null);
    submitAbortRef.current = null;
    setIsPickingFolder(false);
    setSubmitting(false);
    setFormError(null);
    // Deferred a frame: the dialog moves focus itself on open, so focusing the
    // name field has to happen after that lands or it is immediately undone.
    const frame = requestAnimationFrame(() => document.getElementById(nameInputId)?.focus());
    return () => cancelAnimationFrame(frame);
  }, [nameInputId, props.open]);

  const trimmedName = name.trim();
  const trimmedPath = folderPath.trim();
  const formErrorMeaning = formError ? describeAddProjectError(formError) : null;
  const pickedFolderName =
    pickedPath !== null && trimmedPath === pickedPath
      ? (pickedPath.split(/[/\\]/).findLast(Boolean) ?? pickedPath)
      : null;

  const applyPickedFolder = useCallback(
    (picked: string) => {
      setFolderPath(picked);
      setPickedPath(picked);
      setFormError(null);
      // Land focus on the confirm button so a plain Enter finishes the flow.
      requestAnimationFrame(() => document.getElementById(submitButtonId)?.focus());
    },
    [submitButtonId],
  );

  const handleBrowse = async () => {
    if (isPickingFolder || submitting) return;
    const api = readNativeApi();
    if (!api) {
      setFormError(t("projectSetup.createProject.appServerUnavailable"));
      return;
    }
    setIsPickingFolder(true);
    // No try/finally: the React Compiler skips optimizing components that use it.
    try {
      const picked = await api.dialogs.pickFolder();
      if (picked) applyPickedFolder(picked);
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : t("projectSetup.createProject.openPickerError"),
      );
    }
    setIsPickingFolder(false);
  };

  // While the dialog is open it is the only interactive surface, so a folder dropped
  // anywhere in the window counts (see useWindowFolderDrop).
  const isDropTarget = useWindowFolderDrop({
    enabled: props.open && isElectron,
    onFolder: applyPickedFolder,
    onError: setFormError,
  });

  const submit = async () => {
    if (submitting) return;
    // The confirm button stays enabled like the reference dialog; an empty
    // submit explains what is missing instead of being unclickable.
    if (trimmedPath.length === 0) {
      setFormError(t("projectSetup.createProject.folderRequired"));
      return;
    }
    setSubmitting(true);
    setFormError(null);
    const abortController = new AbortController();
    submitAbortRef.current = abortController;
    try {
      await props.onSubmit(
        {
          source: "local",
          workspaceRoot: trimmedPath,
          ...(trimmedName.length > 0 ? { name: trimmedName } : {}),
          spaceId: props.activeSpaceId ?? null,
          createIfMissing: trimmedPath !== pickedPath,
        },
        { signal: abortController.signal },
      );
      submitAbortRef.current = null;
      props.onOpenChange(false);
    } catch (error) {
      submitAbortRef.current = null;
      setFormError(
        abortController.signal.aborted
          ? t("projectSetup.createProject.projectCreationCancelled")
          : error instanceof Error
            ? error.message
            : t("projectSetup.createProject.addError"),
      );
      setSubmitting(false);
    }
  };

  const submitOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void submit();
  };

  // The Codex picker layout (location dropdown + Add button + removable chip)
  // renders wherever a native folder picker exists: Electron's preload bridge,
  // or — in a browser — the server-hosted picker advertised through the
  // environment capabilities. Only when neither exists does the source folder
  // fall back to a typed path. Electron never queries: the bridge is the
  // picker there and the descriptor fetch would go nowhere.
  const { data: serverEnvironment } = useQuery({
    ...serverEnvironmentQueryOptions(),
    enabled: !isElectron,
  });
  const hasFolderPicker = isElectron || serverEnvironment?.capabilities.folderPicker === true;

  const handleOpenChange = (open: boolean) => {
    if (!open) submitAbortRef.current?.abort();
    props.onOpenChange(open);
  };

  return (
    <Dialog open={props.open} onOpenChange={handleOpenChange}>
      <DialogPopup>
        <DialogHeader className="px-5 pt-5">
          <DialogTitle>{t("projectSetup.createProject.title")}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-4 px-5">
          <InputGroup className={cn(PROJECT_DIALOG_FIELD_CONTROL_CLASS_NAME, "mt-2")}>
            <InputGroupAddon className="w-10 self-stretch border-e border-foreground/12 ps-0">
              <FolderIcon className="size-4 text-muted-foreground/70" aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              id={nameInputId}
              value={name}
              aria-label={t("projectSetup.createProject.projectName")}
              aria-invalid={formError ? true : undefined}
              {...(formError ? { "aria-describedby": errorId } : {})}
              placeholder={pickedFolderName ?? t("projectSetup.createProject.projectName")}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              onChange={(event) => {
                setName(event.target.value);
                setFormError(null);
              }}
              onKeyDown={submitOnEnter}
            />
          </InputGroup>

          <div className="space-y-2">
            <span
              id={sourceFolderLabelId}
              className={cn("block", dialogFieldLabelClassName, "text-ui text-foreground")}
            >
              {t("projectSetup.createProject.sourceFolder")}
            </span>
            <div
              aria-labelledby={sourceFolderLabelId}
              className={cn(
                "rounded-xl border border-foreground/10 bg-foreground/[0.025] px-3.5 py-3 transition-colors",
                isDropTarget && "border-[color:var(--color-border-focus)] bg-foreground/6",
              )}
            >
              {pickedFolderName ? (
                <div className="flex items-center gap-2.5">
                  <FolderIcon
                    className="size-4 shrink-0 text-muted-foreground/70"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate text-ui" title={pickedPath ?? undefined}>
                    {pickedFolderName}
                  </span>
                  <button
                    type="button"
                    aria-label={t("projectSetup.createProject.removeFolder")}
                    disabled={submitting}
                    className="-me-1 shrink-0 cursor-pointer rounded-sm p-1 text-muted-foreground/55 transition-colors hover:text-foreground disabled:opacity-50"
                    onClick={() => {
                      setFolderPath("");
                      setPickedPath(null);
                      setFormError(null);
                    }}
                  >
                    <XIcon className="size-4" aria-hidden="true" />
                  </button>
                </div>
              ) : hasFolderPicker ? (
                <div className="flex flex-col items-center gap-2.5 py-1">
                  <Select value="this-computer" onValueChange={() => {}}>
                    <SelectTrigger
                      aria-label={t("projectSetup.createProject.locationPicker")}
                      className="h-auto w-auto gap-1.5 rounded-lg border-0 bg-transparent px-2 py-1 text-ui shadow-none hover:bg-foreground/4 focus-visible:border-foreground/30"
                    >
                      <SelectValue>
                        {t("projectSetup.createProject.addFolderOnComputer")}
                      </SelectValue>
                    </SelectTrigger>
                    <ComposerPickerSelectPopup align="center">
                      <SelectItem value="this-computer">
                        <span className="flex items-center gap-2">
                          <DeviceLaptopIcon className="size-4" aria-hidden="true" />
                          {t("projectSetup.createProject.thisComputer")}
                        </span>
                      </SelectItem>
                      <SelectGroup>
                        <SelectGroupLabel>
                          {t("projectSetup.createProject.remoteDevices")}
                        </SelectGroupLabel>
                        <div className="px-2.5 py-1 text-ui text-muted-foreground/60">
                          {t("projectSetup.createProject.noConnectedRemotes")}
                        </div>
                      </SelectGroup>
                      {/* Remote hosts are not wired up yet; the entry stays visible
                          (like the reference dialog) but disabled. */}
                      <SelectItem value="add-remote" disabled hideIndicator>
                        <span className="flex items-center gap-2">
                          <PlusIcon className="size-4" aria-hidden="true" />
                          {t("projectSetup.createProject.addRemoteHost")}
                        </span>
                      </SelectItem>
                    </ComposerPickerSelectPopup>
                  </Select>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isPickingFolder || submitting}
                    onClick={() => void handleBrowse()}
                  >
                    <FolderAddIcon className="size-4" aria-hidden="true" />
                    {isPickingFolder
                      ? t("projectSetup.createProject.openFolderPicker")
                      : t("projectSetup.createProject.add")}
                  </Button>
                </div>
              ) : (
                // No picker exists at all (a browser talking to a server whose
                // host cannot raise one), so the path is typed instead.
                <InputGroup className={PROJECT_DIALOG_FIELD_CONTROL_CLASS_NAME}>
                  <InputGroupAddon className="w-10 self-stretch border-e border-foreground/12 ps-0">
                    <FolderIcon className="size-4 text-muted-foreground/70" aria-hidden="true" />
                  </InputGroupAddon>
                  <InputGroupInput
                    id={pathInputId}
                    value={folderPath}
                    aria-label={t("projectSetup.createProject.folderPath")}
                    aria-invalid={formError ? true : undefined}
                    placeholder={t("projectSetup.createProject.folderPathPlaceholder")}
                    spellCheck={false}
                    autoCorrect="off"
                    autoCapitalize="off"
                    onChange={(event) => {
                      setFolderPath(event.target.value);
                      setPickedPath(null);
                      setFormError(null);
                    }}
                    onKeyDown={submitOnEnter}
                  />
                </InputGroup>
              )}
            </div>
          </div>

          {formError ? (
            <div id={errorId} role="alert" className="space-y-1">
              <p className="text-ui-xs text-destructive">{formError}</p>
              {formErrorMeaning ? (
                <p className="text-ui-xs text-muted-foreground/70">{formErrorMeaning}</p>
              ) : null}
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter className="px-5 pb-5">
          <Button
            variant="ghost"
            shape="capsule"
            className="px-4 text-ui-lg sm:text-ui-lg"
            onClick={() => handleOpenChange(false)}
          >
            {t("projectSetup.createProject.cancel")}
          </Button>
          <Button
            id={submitButtonId}
            variant="prominent"
            className="px-4 text-ui-lg transition-opacity hover:scale-100 sm:text-ui-lg"
            onClick={() => void submit()}
            disabled={submitting}
          >
            {submitting
              ? t("projectSetup.createProject.creating")
              : t("projectSetup.createProject.create")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
