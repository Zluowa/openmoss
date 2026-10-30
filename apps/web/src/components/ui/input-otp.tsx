"use client";

import {
  OTPInput as OTPInputPrimitive,
  REGEXP_ONLY_DIGITS,
  type OTPInputProps as OTPInputPrimitiveProps,
  type RenderProps,
  type SlotProps,
} from "input-otp";
import { forwardRef } from "react";

import { cn } from "~/lib/utils";

type MossOtpInputProps = Omit<OTPInputPrimitiveProps, "children" | "maxLength" | "render"> & {
  readonly containerClassName?: string;
};

const MOSS_OTP_SLOT_KEYS = [
  "moss-otp-slot-1",
  "moss-otp-slot-2",
  "moss-otp-slot-3",
  "moss-otp-slot-4",
  "moss-otp-slot-5",
  "moss-otp-slot-6",
] as const;

function OtpSlot({
  slot,
  index,
  slotCount,
}: {
  slot: SlotProps;
  index: number;
  slotCount: number;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "relative flex h-11 min-w-0 flex-1 items-center justify-center border border-border bg-background text-ui-lg font-medium tabular-nums text-foreground transition-colors",
        index === 0 && "rounded-l-xl",
        index === slotCount - 1 && "rounded-r-xl",
        index > 0 && "-ml-px",
        slot.isActive && "z-10 border-foreground ring-2 ring-ring/45",
      )}
      data-testid="moss-otp-slot"
    >
      {slot.char ?? <span className="text-muted-foreground/45">{slot.placeholderChar ?? " "}</span>}
      {slot.hasFakeCaret ? (
        <span
          aria-hidden="true"
          className="absolute inset-y-2.5 w-px animate-pulse bg-foreground"
        />
      ) : null}
    </div>
  );
}

/**
 * Moss's six-digit verification field.
 *
 * The library keeps one real input under these visual slots, so browser SMS
 * autofill, paste, undo, screen readers, and password-manager badges keep
 * their native behavior instead of being reimplemented per slot.
 */
export const MossOtpInput = forwardRef<HTMLInputElement, MossOtpInputProps>(function MossOtpInput(
  { className, containerClassName, ...props },
  ref,
) {
  return (
    <OTPInputPrimitive
      {...props}
      ref={ref}
      autoComplete={props.autoComplete ?? "one-time-code"}
      className={cn("focus:outline-none", className)}
      containerClassName={cn("flex w-full", containerClassName)}
      inputMode={props.inputMode ?? "numeric"}
      maxLength={6}
      pattern={props.pattern ?? REGEXP_ONLY_DIGITS}
      pushPasswordManagerStrategy={props.pushPasswordManagerStrategy ?? "increase-width"}
      render={({ slots }: RenderProps) => (
        <div className="flex w-full" data-slot="input-otp-slots">
          {slots.map((slot, index) => (
            <OtpSlot
              key={MOSS_OTP_SLOT_KEYS[index] ?? `moss-otp-slot-${index + 1}`}
              index={index}
              slot={slot}
              slotCount={slots.length}
            />
          ))}
        </div>
      )}
    />
  );
});

MossOtpInput.displayName = "MossOtpInput";
