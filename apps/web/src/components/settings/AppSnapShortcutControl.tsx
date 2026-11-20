// FILE: AppSnapShortcutControl.tsx
// Purpose: Record, validate, and save AppSnap's global shortcut across macOS and Windows.

import {
  type DesktopAppSnapKeyChord,
  type DesktopAppSnapPlatform,
  type DesktopAppSnapShortcut,
  type DesktopAppSnapShortcutAvailability,
  type DesktopAppSnapShortcutModifier,
  type DesktopAppSnapState,
  type ResolvedKeybindingsConfig,
} from "@moss/contracts";
import {
  appSnapModifierFromEventCode,
  appSnapShortcutLabels,
  appSnapShortcutModifierLabel,
  appSnapShortcutSystemConflict,
  createAppSnapKeyChord,
  defaultAppSnapShortcut,
  isAppSnapShortcutKey,
  normalizeAppSnapShortcutForPlatform,
  sameAppSnapShortcut,
} from "@moss/shared/appSnapShortcut";
import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from "react";

import { appSnapShortcutConflictCommand } from "~/appSnapShortcut";
import { suspendShortcutDispatch } from "~/keybindings";
import { shortcutSheetCommandLabel } from "~/shortcutsSheet";
import { useTranslation } from "~/localization";
import { cn, getNavigatorPlatform, isMacPlatform, isWindowsPlatform } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Kbd, KbdGroup } from "~/components/ui/kbd";
import { toastManager } from "~/components/ui/toast";

type ShortcutCheckState =
  | { status: "idle"; availability: null }
  | { status: "checking"; availability: null }
  | { status: "checked"; availability: DesktopAppSnapShortcutAvailability };

interface CaptureState {
  capturing: boolean;
  /** Physical modifier codes currently held, in press order. */
  heldModifierCodes: readonly string[];
  /** Guidance after an invalid press; capture stays active so the user can retry. */
  hint: string | null;
}

const IDLE_CAPTURE: CaptureState = { capturing: false, heldModifierCodes: [], hint: null };
const KEYCAP_CLASS_NAME =
  "border border-[color:var(--color-border)] bg-foreground/[0.06] px-1.5 text-ui-xs font-medium text-foreground dark:bg-foreground/[0.12]";

function heldModifiers(
  codes: readonly string[],
  platform: DesktopAppSnapPlatform,
): readonly DesktopAppSnapShortcutModifier[] {
  const modifiers: DesktopAppSnapShortcutModifier[] = [];
  for (const code of codes) {
    const modifier = appSnapModifierFromEventCode(code);
    if (modifier && !modifiers.includes(modifier)) modifiers.push(modifier);
  }
  const order: readonly DesktopAppSnapShortcutModifier[] =
    platform === "windows" || platform === "linux"
      ? ["control", "option", "shift", "command"]
      : ["command", "control", "option", "shift"];
  return order.filter((modifier) => modifiers.includes(modifier));
}

function resolvePlatform(platform?: DesktopAppSnapPlatform): DesktopAppSnapPlatform {
  if (platform) return platform;
  const nav = getNavigatorPlatform();
  if (isWindowsPlatform(nav)) return "windows";
  if (isMacPlatform(nav)) return "macos";
  return "other";
}

export function AppSnapShortcutControl({
  shortcut,
  platform: platformProp,
  enabled,
  reserved,
  stateError,
  keybindings,
  onSaved,
}: {
  shortcut: DesktopAppSnapShortcut;
  platform?: DesktopAppSnapPlatform;
  enabled: boolean;
  reserved: boolean;
  stateError?: string | null;
  keybindings: ResolvedKeybindingsConfig;
  onSaved: (shortcut: DesktopAppSnapShortcut, state: DesktopAppSnapState) => void;
}) {
  const platform = resolvePlatform(platformProp);
  const isWindows = platform === "windows";
  const defaultShortcut = defaultAppSnapShortcut(platform);
  const effectiveShortcut = normalizeAppSnapShortcutForPlatform(shortcut, platform);

  const [capture, setCapture] = useState<CaptureState>(IDLE_CAPTURE);
  const [candidate, setCandidate] = useState<DesktopAppSnapShortcut>(effectiveShortcut);
  const [checkState, setCheckState] = useState<ShortcutCheckState>({
    status: "idle",
    availability: null,
  });
  const checkIdRef = useRef(0);
  // Source of truth for held modifiers: consecutive keydowns can arrive before
  // React re-renders, so the render-time capture state may lag one event behind.
  const heldCodesRef = useRef<string[]>([]);
  const { t } = useTranslation();
  // Keycaps skip page translation, so the two-Option-key labels come from the locale
  // table, and off macOS they name the key on the keyboard: Alt, not ⌥.
  const onMac = isMacPlatform(getNavigatorPlatform());
  const labels: readonly string[] =
    candidate.kind === "both-option-keys"
      ? onMac
        ? [t("settings.appsnap.shortcut.left"), t("settings.appsnap.shortcut.right")]
        : [t("settings.appsnap.shortcut.altLeft"), t("settings.appsnap.shortcut.altRight")]
      : appSnapShortcutLabels(candidate, platform);
  const changed = !sameAppSnapShortcut(candidate, effectiveShortcut);
  const canSave = changed && checkState.availability?.available === true;
  const canReset = !sameAppSnapShortcut(candidate, defaultShortcut);
  const capturedModifiers = heldModifiers(capture.heldModifierCodes, platform);

  useEffect(() => {
    if (!capture.capturing) return;
    return suspendShortcutDispatch();
  }, [capture.capturing]);

  function reportUnavailable(reason: string) {
    setCheckState({ status: "checked", availability: { available: false, reason } });
  }

  async function checkCandidate(nextCandidate: DesktopAppSnapKeyChord) {
    const checkId = ++checkIdRef.current;
    const conflictCommand = appSnapShortcutConflictCommand(nextCandidate, keybindings, platform);
    if (conflictCommand) {
      const commandLabel = shortcutSheetCommandLabel(conflictCommand) ?? conflictCommand;
      reportUnavailable(`Moss already uses this for “${commandLabel}”.`);
      return;
    }
    const systemConflict = appSnapShortcutSystemConflict(nextCandidate, platform);
    if (systemConflict) {
      reportUnavailable(systemConflict);
      return;
    }
    const bridge = window.desktopBridge?.appSnap;
    if (!bridge) {
      reportUnavailable("Requires the Moss desktop app.");
      return;
    }
    setCheckState({ status: "checking", availability: null });
    try {
      const availability = await bridge.checkShortcut(nextCandidate);
      if (checkId === checkIdRef.current) {
        setCheckState({ status: "checked", availability });
      }
    } catch (error) {
      if (checkId !== checkIdRef.current) return;
      reportUnavailable(error instanceof Error ? error.message : "Could not check this shortcut.");
    }
  }

  function startCapture() {
    heldCodesRef.current = [];
    setCapture({ capturing: true, heldModifierCodes: [], hint: null });
    setCheckState({ status: "idle", availability: null });
  }

  function stopCapture() {
    heldCodesRef.current = [];
    setCapture(IDLE_CAPTURE);
  }

  function captureKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!capture.capturing || event.repeat) return;
    event.preventDefault();
    event.stopPropagation();
    const code = event.code;
    if (appSnapModifierFromEventCode(code)) {
      if (!heldCodesRef.current.includes(code)) heldCodesRef.current.push(code);
      setCapture((previous) => ({
        ...previous,
        heldModifierCodes: [...heldCodesRef.current],
        hint: null,
      }));
      return;
    }
    const modifiers = heldModifiers(heldCodesRef.current, platform);
    if (code === "Escape" && modifiers.length === 0) {
      stopCapture();
      return;
    }
    if (!isAppSnapShortcutKey(code)) {
      setCapture((previous) => ({ ...previous, hint: "That key isn't supported — try another." }));
      return;
    }
    if (modifiers.length === 0) {
      setCapture((previous) => ({
        ...previous,
        hint: isWindows
          ? "Hold Ctrl or Alt first, then press a key."
          : "Hold ⌘, ⌃, ⌥ or ⇧ first, then press the other key.",
      }));
      return;
    }
    if (modifiers.length > 2) {
      setCapture((previous) => ({ ...previous, hint: "Hold one or two modifiers." }));
      return;
    }
    const nextCandidate = createAppSnapKeyChord(modifiers, code);
    if (!nextCandidate) {
      setCapture((previous) => ({ ...previous, hint: "That key isn't supported — try another." }));
      return;
    }
    stopCapture();
    setCandidate(nextCandidate);
    void checkCandidate(nextCandidate);
  }

  function captureKeyUp(event: KeyboardEvent<HTMLButtonElement>) {
    if (!capture.capturing) return;
    event.preventDefault();
    event.stopPropagation();
    const code = event.code;
    if (!heldCodesRef.current.includes(code)) return;
    heldCodesRef.current = heldCodesRef.current.filter((held) => held !== code);
    setCapture((previous) => ({
      ...previous,
      heldModifierCodes: [...heldCodesRef.current],
    }));
  }

  async function saveShortcut(nextShortcut: DesktopAppSnapShortcut) {
    const bridge = window.desktopBridge?.appSnap;
    if (!bridge) return;
    const result = await bridge.setShortcut(nextShortcut);
    setCandidate(nextShortcut);
    setCheckState({ status: "idle", availability: null });
    // The manager adopts every well-formed shortcut, so keep settings in sync
    // even if availability regressed between the check and the save.
    onSaved(nextShortcut, result.state);
    if (result.availability.available) {
      toastManager.add({
        type: "success",
        title: "AppSnap shortcut saved",
        description: enabled
          ? "The shortcut is reserved while AppSnap is enabled."
          : "The shortcut will be reserved when you enable AppSnap.",
      });
    } else if (result.availability.reason) {
      toastManager.add({
        type: "error",
        title: "AppSnap shortcut saved, but unavailable",
        description: result.availability.reason,
      });
    }
  }

  const activeError =
    !capture.capturing && !changed && !checkState.availability ? stateError : null;
  const statusText = capture.capturing
    ? (capture.hint ??
      (capturedModifiers.length > 0
        ? "Now press a key…"
        : isWindows
          ? "Hold Ctrl or Alt, then press a key. Esc cancels."
          : "Hold a modifier, then press one other key. Esc cancels."))
    : checkState.status === "checking"
      ? isWindows
        ? "Checking Windows and other apps…"
        : "Checking macOS and other apps…"
      : checkState.availability
        ? checkState.availability.available
          ? "Available — save to apply."
          : checkState.availability.reason
        : changed
          ? "Check a new combination before saving."
          : activeError
            ? activeError
            : reserved && candidate.kind === "key-chord"
              ? "Active and ready"
              : "Current shortcut";

  const statusToneClassName =
    checkState.availability?.available === false || Boolean(activeError)
      ? "text-destructive"
      : checkState.availability?.available === true ||
          (!capture.capturing && !changed && reserved && candidate.kind === "key-chord")
        ? "text-[var(--color-status-success)]"
        : "text-muted-foreground";

  return (
    <div className="flex w-full flex-col items-stretch gap-1.5 sm:w-auto sm:items-end">
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label="Record AppSnap shortcut"
          aria-pressed={capture.capturing}
          onClick={startCapture}
          onKeyDown={captureKeyDown}
          onKeyUp={captureKeyUp}
          onBlur={stopCapture}
          className={cn(
            "px-2 font-normal transition-colors duration-120 motion-reduce:transition-none",
            capture.capturing
              ? "border-primary bg-primary/10 ring-2 ring-primary/20 hover:bg-primary/10"
              : "bg-transparent hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-primary/30",
          )}
        >
          {capture.capturing ? (
            capturedModifiers.length > 0 ? (
              <KbdGroup className="gap-1">
                {capturedModifiers.map((modifier) => (
                  <Fragment key={modifier}>
                    <Kbd className={KEYCAP_CLASS_NAME}>
                      {appSnapShortcutModifierLabel(modifier, platform)}
                    </Kbd>
                    <span className="text-ui-xs text-muted-foreground">+</span>
                  </Fragment>
                ))}
                <span className="animate-pulse px-0.5 text-ui-xs text-muted-foreground motion-reduce:animate-none">
                  …
                </span>
              </KbdGroup>
            ) : (
              <span className="animate-pulse px-1 text-ui-sm font-medium text-muted-foreground motion-reduce:animate-none">
                {isWindows ? "Press shortcut…" : "Press two keys…"}
              </span>
            )
          ) : (
            <KbdGroup className="gap-1">
              {labels.map((label, index) => (
                <Fragment key={`${label}-${index}`}>
                  {index > 0 ? <span className="text-ui-xs text-muted-foreground">+</span> : null}
                  <Kbd className={KEYCAP_CLASS_NAME}>{label}</Kbd>
                </Fragment>
              ))}
            </KbdGroup>
          )}
        </Button>
        {changed ? (
          <Button size="sm" disabled={!canSave} onClick={() => void saveShortcut(candidate)}>
            Save
          </Button>
        ) : canReset ? (
          <Button size="sm" variant="ghost" onClick={() => void saveShortcut(defaultShortcut)}>
            Reset
          </Button>
        ) : null}
      </div>
      <span
        role="status"
        className={cn("max-w-72 text-left text-ui-xs sm:text-right", statusToneClassName)}
      >
        {statusText}
      </span>
    </div>
  );
}
