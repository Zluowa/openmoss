// Adapted from Threebot @ 4f482cc (MIT). See third_party/threebot/NOTICE.md.
// Narrow windows and touch devices both need tap-only keyboard activation.
export const MOBILE_CHAT_QUERY = "(max-width: 760px), (pointer: coarse)";

type ComposerTarget = Pick<HTMLTextAreaElement, "readOnly" | "focus" | "blur">;

/** Keep focus restoration from overlays from reopening the software keyboard. */
export function composerFocusBehavior(requiresTap: boolean) {
  let state: "idle" | "tapped" | "editing" = "idle";
  return {
    onEntry(target: ComposerTarget | null) {
      state = "idle";
      if (!target) return;
      target.readOnly = requiresTap;
      if (requiresTap) target.blur();
      else target.focus();
    },
    onPointerDown(target: ComposerTarget) {
      if (!requiresTap) return;
      if (state !== "editing") state = "tapped";
      // This must happen before the pointer's default focus action, including on iOS.
      target.readOnly = false;
    },
    onClick(target: ComposerTarget) {
      // Screen readers and accessibility automation can activate with click
      // alone. Read-only tap protection must not strand those users.
      if (!requiresTap || state === "editing") return;
      state = "tapped";
      target.readOnly = false;
      target.focus();
    },
    onFocus(target: ComposerTarget) {
      if (requiresTap && state === "idle") {
        state = "idle";
        target.readOnly = true;
        target.blur();
        return;
      }
      state = "editing";
    },
    onBlur(target: ComposerTarget) {
      state = "idle";
      target.readOnly = requiresTap;
    },
    onPointerCancel(target: ComposerTarget) {
      if (state !== "tapped") return;
      state = "idle";
      if (requiresTap) target.readOnly = true;
    },
  };
}
