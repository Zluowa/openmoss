// FILE: ProfileIdentityHeader.tsx
// Purpose: Centered ChatGPT-style Profile hero with large clickable avatar, inline-editable
//          display name and unique @handle (live availability check via `#759`), and a
//          quiet account/plan status bar.
// Layer: Web profile feature

import type {
  MossProfileAvatar,
  MossProfileCheckHandleResult,
  MossProfileHandleStatus,
  MossProfileSync,
} from "@moss/contracts";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";

import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupText } from "~/components/ui/input-group";
import { CentralIcon } from "~/lib/central-icons";
import { CameraIcon, CheckIcon, XIcon } from "~/lib/icons";
import { isImeComposingKeyEvent } from "~/lib/imeKeyEvent";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { resolveProfileAvatarSrc } from "./profileAvatarPresets";
import { getProfileCopy } from "./profileCopy";
import { ProfileAvatar } from "./ProfileAvatar";
import {
  classifyProfileError,
  formatDisplayHandle,
  normalizeProfileHandleDraft,
  validateProfileDisplayName,
  validateProfileHandleLocal,
} from "./profileValidation";

export interface ProfileIdentityHeaderProps {
  readonly account: "signedIn" | "signedOut" | "checking";
  readonly presentation: "page" | "settings";
  readonly displayName: string;
  /** Visible heading when signed out and never customized (e.g. "未登录"). */
  readonly headerTitle: string;
  readonly handle: string | null;
  readonly initials: string;
  readonly avatar: MossProfileAvatar;
  readonly avatarColor: string;
  readonly legacyAvatarImage: string | null;
  readonly showSignedOutAvatarGlyph: boolean;
  readonly editable: boolean;
  readonly sync: MossProfileSync;
  readonly planName?: string | null;
  readonly accountSummary?: string | null;
  readonly onOpenAvatarPicker: () => void;
  readonly onSaveDisplayName: (displayName: string) => Promise<void>;
  readonly onSaveHandle: (handle: string) => Promise<void>;
  readonly onCheckHandle: (rawHandle: string) => Promise<MossProfileCheckHandleResult>;
  readonly onSignIn: () => void;
  readonly onOpenAccountSettings?: () => void;
  readonly onRetrySync?: () => void;
}

const HANDLE_CHECK_DEBOUNCE_MS = 220;

export function ProfileIdentityHeader({
  account,
  presentation,
  displayName,
  headerTitle,
  handle,
  initials,
  avatar,
  avatarColor,
  legacyAvatarImage,
  showSignedOutAvatarGlyph,
  editable,
  sync,
  planName = null,
  accountSummary = null,
  onOpenAvatarPicker,
  onSaveDisplayName,
  onSaveHandle,
  onCheckHandle,
  onSignIn,
  onOpenAccountSettings,
  onRetrySync,
}: ProfileIdentityHeaderProps) {
  const { locale } = useTranslation();
  const copy = getProfileCopy(locale);

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(displayName);
  const [nameError, setNameError] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const [editingHandle, setEditingHandle] = useState(false);
  const [handleDraft, setHandleDraft] = useState(() => normalizeProfileHandleDraft(handle ?? ""));
  const [handleStatus, setHandleStatus] = useState<MossProfileHandleStatus | null>(null);
  const [checkingHandle, setCheckingHandle] = useState(false);
  const [handleSaveError, setHandleSaveError] = useState<string | null>(null);
  const [savingHandle, setSavingHandle] = useState(false);
  const handleInputRef = useRef<HTMLInputElement>(null);
  const handleCheckTokenRef = useRef(0);

  const avatarSrc = resolveProfileAvatarSrc(avatar, legacyAvatarImage);
  const formattedHandle = formatDisplayHandle(handle);
  const currentNormalizedHandle = normalizeProfileHandleDraft(handle ?? "");

  // Debounced live handle availability check while editing `@handle`.
  useEffect(() => {
    if (!editingHandle) {
      return;
    }
    const normalized = normalizeProfileHandleDraft(handleDraft);
    const localError = validateProfileHandleLocal(normalized);
    if (localError) {
      setHandleStatus(localError);
      setCheckingHandle(false);
      return;
    }
    if (normalized === currentNormalizedHandle && currentNormalizedHandle.length > 0) {
      setHandleStatus("current");
      setCheckingHandle(false);
      return;
    }
    const token = handleCheckTokenRef.current + 1;
    handleCheckTokenRef.current = token;
    setCheckingHandle(true);
    setHandleStatus(null);
    const timer = window.setTimeout(() => {
      void onCheckHandle(normalized)
        .then((result) => {
          if (handleCheckTokenRef.current !== token) {
            return;
          }
          setHandleStatus(result.status);
          setCheckingHandle(false);
        })
        .catch(() => {
          if (handleCheckTokenRef.current !== token) {
            return;
          }
          setHandleStatus("unverified");
          setCheckingHandle(false);
        });
    }, HANDLE_CHECK_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [currentNormalizedHandle, editingHandle, handleDraft, onCheckHandle]);

  const startEditingName = () => {
    if (!editable) {
      return;
    }
    setEditingHandle(false);
    setNameDraft(displayName);
    setNameError(null);
    setEditingName(true);
    requestAnimationFrame(() => {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    });
  };

  const cancelEditingName = () => {
    setEditingName(false);
    setNameError(null);
  };

  const commitName = async () => {
    const trimmed = nameDraft.trim();
    const validationError = validateProfileDisplayName(trimmed);
    if (validationError) {
      setNameError(copy.nameErrors[validationError]);
      nameInputRef.current?.focus();
      return;
    }
    if (trimmed === displayName) {
      setEditingName(false);
      setNameError(null);
      return;
    }
    setSavingName(true);
    setNameError(null);
    try {
      await onSaveDisplayName(trimmed);
      setEditingName(false);
    } catch (cause) {
      setNameError(copy.errors[classifyProfileError(cause)]);
    } finally {
      setSavingName(false);
    }
  };

  const handleNameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposingKeyEvent(event)) {
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      void commitName();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelEditingName();
    }
  };

  const startEditingHandle = () => {
    if (!editable) {
      return;
    }
    setEditingName(false);
    setHandleDraft(currentNormalizedHandle);
    setHandleStatus(currentNormalizedHandle ? "current" : null);
    setHandleSaveError(null);
    setEditingHandle(true);
    requestAnimationFrame(() => {
      handleInputRef.current?.focus();
      handleInputRef.current?.select();
    });
  };

  const cancelEditingHandle = () => {
    setEditingHandle(false);
    setHandleSaveError(null);
    setCheckingHandle(false);
  };

  const normalizedHandleDraft = normalizeProfileHandleDraft(handleDraft);
  const localHandleIssue = validateProfileHandleLocal(normalizedHandleDraft);
  const canSubmitHandle =
    !savingHandle &&
    !checkingHandle &&
    localHandleIssue === null &&
    handleStatus !== "taken" &&
    handleStatus !== "reserved";

  const commitHandle = async () => {
    const normalized = normalizeProfileHandleDraft(handleDraft);
    const localError = validateProfileHandleLocal(normalized);
    if (localError) {
      setHandleStatus(localError);
      handleInputRef.current?.focus();
      return;
    }
    if (normalized === currentNormalizedHandle) {
      setEditingHandle(false);
      setHandleSaveError(null);
      return;
    }
    if (handleStatus === "taken" || handleStatus === "reserved") {
      handleInputRef.current?.focus();
      return;
    }
    setSavingHandle(true);
    setHandleSaveError(null);
    try {
      await onSaveHandle(normalized);
      setEditingHandle(false);
    } catch (cause) {
      const kind = classifyProfileError(cause);
      if (kind === "handleTaken") {
        setHandleStatus("taken");
      }
      setHandleSaveError(copy.errors[kind]);
    } finally {
      setSavingHandle(false);
    }
  };

  const handleHandleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposingKeyEvent(event)) {
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      void commitHandle();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelEditingHandle();
    }
  };

  const avatarSizeClass = presentation === "page" ? "size-24" : "size-20";
  const avatarTextClass = presentation === "page" ? "text-2xl" : "text-xl";

  const avatarVisual =
    showSignedOutAvatarGlyph && !avatarSrc ? (
      <div
        data-profile-avatar-signed-out=""
        className={cn(
          "flex items-center justify-center rounded-full border border-border/70 bg-muted text-muted-foreground",
          avatarSizeClass,
        )}
      >
        <CentralIcon name="user" className="size-8" />
      </div>
    ) : (
      <ProfileAvatar
        initials={initials}
        color={avatarColor}
        image={avatarSrc}
        className={cn("border border-border/70", avatarSizeClass)}
        textClassName={avatarTextClass}
      />
    );

  const handleStatusToneClass =
    handleStatus === "available"
      ? "text-emerald-600 dark:text-emerald-400"
      : handleStatus === "taken" ||
          handleStatus === "reserved" ||
          handleStatus === "too_short" ||
          handleStatus === "too_long" ||
          handleStatus === "invalid_characters"
        ? "text-destructive"
        : "text-muted-foreground";

  return (
    <header className="flex flex-col items-center gap-3.5 text-center">
      {/* Large clickable circular avatar */}
      {editable ? (
        <div className="relative">
          <Button
            type="button"
            variant="ghost"
            shape="capsule"
            aria-label={copy.changeAvatar}
            title={copy.changeAvatar}
            data-testid="profile-avatar-trigger"
            onClick={onOpenAvatarPicker}
            className={cn(
              "group relative h-auto rounded-full p-0 hover:bg-transparent focus-visible:ring-2 focus-visible:ring-ring",
              avatarSizeClass,
            )}
          >
            {avatarVisual}
            <span
              aria-hidden="true"
              className="absolute right-0 bottom-0 flex size-7 items-center justify-center rounded-full border border-border bg-popover text-foreground shadow-sm transition-colors group-hover:bg-accent"
            >
              <CameraIcon className="size-3.5" />
            </span>
          </Button>
        </div>
      ) : (
        <div className="relative">{avatarVisual}</div>
      )}

      {/* Inline editable display name + @handle */}
      <div className="flex w-full max-w-md flex-col items-center gap-1.5">
        {editingName ? (
          <div className="flex flex-col items-center gap-1.5">
            <div className="flex items-center gap-1.5">
              <Input
                ref={nameInputRef}
                aria-label={copy.editNameAria}
                aria-invalid={Boolean(nameError)}
                value={nameDraft}
                maxLength={32}
                disabled={savingName}
                placeholder={copy.namePlaceholder}
                data-testid="profile-name-input"
                onChange={(event) => {
                  setNameDraft(event.target.value);
                  setNameError(null);
                }}
                onKeyDown={handleNameKeyDown}
                className="h-9 w-56 text-center text-ui-lg"
              />
              <Button
                type="button"
                variant="default"
                size="icon-sm"
                aria-label={copy.save}
                disabled={savingName}
                data-testid="profile-name-save"
                onClick={() => void commitName()}
              >
                <CheckIcon className="size-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={copy.cancel}
                disabled={savingName}
                onClick={cancelEditingName}
              >
                <XIcon className="size-4" />
              </Button>
            </div>
            {nameError ? (
              <p role="alert" className="text-ui-sm text-destructive">
                {nameError}
              </p>
            ) : null}
          </div>
        ) : editable ? (
          <Button
            type="button"
            variant="ghost"
            aria-label={copy.editNameAria}
            data-testid="profile-name-trigger"
            onClick={startEditingName}
            className="group h-auto max-w-full rounded-control border border-transparent px-3 py-1 font-normal hover:border-border/80 hover:bg-[color-mix(in_srgb,var(--color-text-foreground)_3.5%,transparent)]"
          >
            <h2 className="truncate text-title font-medium tracking-tight text-foreground">
              {headerTitle}
            </h2>
            <CentralIcon
              name="pencil"
              className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-80 group-focus-visible:opacity-80"
            />
          </Button>
        ) : (
          <h2 className="text-title font-medium tracking-tight text-foreground">{headerTitle}</h2>
        )}

        {/* Inline @handle editor */}
        {editingHandle ? (
          <div className="flex flex-col items-center gap-1.5">
            <div className="flex items-center gap-1.5">
              <InputGroup className="h-9 w-60 rounded-control border-border">
                <InputGroupAddon>
                  <InputGroupText>@</InputGroupText>
                </InputGroupAddon>
                <Input
                  ref={handleInputRef}
                  unstyled
                  aria-label={copy.editHandleAria}
                  aria-invalid={
                    Boolean(handleSaveError) ||
                    handleStatus === "taken" ||
                    handleStatus === "reserved" ||
                    handleStatus === "too_short" ||
                    handleStatus === "too_long" ||
                    handleStatus === "invalid_characters"
                  }
                  value={handleDraft}
                  maxLength={24}
                  disabled={savingHandle}
                  placeholder={copy.handlePlaceholder}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  data-testid="profile-handle-input"
                  onChange={(event) => {
                    setHandleDraft(
                      event.target.value.replace(/^@+/u, "").replace(/\s+/gu, "").toLowerCase(),
                    );
                    setHandleSaveError(null);
                  }}
                  onKeyDown={handleHandleKeyDown}
                />
              </InputGroup>
              <Button
                type="button"
                variant="default"
                size="icon-sm"
                aria-label={copy.save}
                disabled={!canSubmitHandle}
                data-testid="profile-handle-save"
                onClick={() => void commitHandle()}
              >
                <CheckIcon className="size-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={copy.cancel}
                disabled={savingHandle}
                onClick={cancelEditingHandle}
              >
                <XIcon className="size-4" />
              </Button>
            </div>
            <p
              role={handleSaveError ? "alert" : "status"}
              aria-live="polite"
              data-testid="profile-handle-feedback"
              className={cn(
                "text-ui-sm",
                handleSaveError ? "text-destructive" : handleStatusToneClass,
              )}
            >
              {handleSaveError
                ? handleSaveError
                : checkingHandle
                  ? copy.handleChecking
                  : handleStatus
                    ? copy.handleStatus[handleStatus]
                    : ""}
            </p>
          </div>
        ) : formattedHandle ? (
          editable ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={copy.editHandleAria}
              data-testid="profile-handle-trigger"
              onClick={startEditingHandle}
              className="group h-auto rounded-control px-2.5 py-0.5 font-normal text-muted-foreground hover:text-foreground"
            >
              <span>{formattedHandle}</span>
              <CentralIcon
                name="pencil"
                className="size-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-80 group-focus-visible:opacity-80"
              />
            </Button>
          ) : (
            <span className="text-ui leading-snug text-muted-foreground">{formattedHandle}</span>
          )
        ) : editable && (account === "signedIn" || presentation === "page") ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            shape="capsule"
            data-testid="profile-handle-trigger"
            onClick={startEditingHandle}
            className="text-muted-foreground hover:text-foreground"
          >
            <CentralIcon name="pencil" className="size-3" />
            {copy.setHandlePrompt}
          </Button>
        ) : null}

        {/* Account / Plan status row */}
        {account === "signedIn" ? (
          <div className="mt-1 flex flex-wrap items-center justify-center gap-2 text-ui-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 px-2.5 py-0.5 text-ui-xs text-muted-foreground">
              <span>Moss</span>
              {planName ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-foreground">{planName}</span>
                </>
              ) : null}
            </span>
            {accountSummary ? (
              <span className="truncate text-ui-xs text-muted-foreground">{accountSummary}</span>
            ) : null}
            {onOpenAccountSettings ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                shape="capsule"
                onClick={onOpenAccountSettings}
                data-testid="profile-manage-account"
              >
                {copy.planManageHint}
              </Button>
            ) : null}
          </div>
        ) : account === "signedOut" && (presentation === "page" || showSignedOutAvatarGlyph) ? (
          <div className="mt-1.5 flex flex-col items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onSignIn}
              data-testid="profile-sign-in"
            >
              {presentation === "page" ? copy.signInToMoss : copy.signIn}
            </Button>
            {presentation === "page" ? (
              <p className="text-ui-xs text-muted-foreground">{copy.signedOutLocalHint}</p>
            ) : null}
          </div>
        ) : null}

        {sync === "offline" ? (
          <Alert className="mt-2 max-w-md text-left" variant="default">
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2 text-ui-sm">
              <span>{copy.offlineNotice}</span>
              {onRetrySync ? (
                <Button type="button" variant="outline" size="xs" onClick={onRetrySync}>
                  {copy.retrySync}
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
      </div>
    </header>
  );
}
