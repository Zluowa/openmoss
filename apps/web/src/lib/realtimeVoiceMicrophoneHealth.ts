// FILE: realtimeVoiceMicrophoneHealth.ts
// Purpose: Converts browser microphone inventory/capture evidence into actionable settings states.
// Layer: Pure renderer helper

export type RealtimeVoiceMicrophoneHealthStatus =
  | "ready"
  | "permission-unchecked"
  | "permission-denied"
  | "no-device"
  | "unsupported"
  | "unavailable";

export interface RealtimeVoiceMicrophoneHealth {
  readonly status: RealtimeVoiceMicrophoneHealthStatus;
  readonly message: string | null;
  readonly actionLabel: string | null;
}

export function resolveRealtimeVoiceMicrophoneHealth(input: {
  readonly audioInputCount: number;
  readonly captureErrorName: string | null;
  readonly enumerationAvailable: boolean;
  readonly enumerationFailed: boolean;
}): RealtimeVoiceMicrophoneHealth {
  if (input.audioInputCount > 0) {
    return { status: "ready", message: null, actionLabel: null };
  }
  if (!input.enumerationAvailable) {
    return {
      status: "unsupported",
      message: "This environment cannot list microphone inputs.",
      actionLabel: null,
    };
  }
  if (input.captureErrorName === "NotAllowedError" || input.captureErrorName === "SecurityError") {
    return {
      status: "permission-denied",
      message:
        "Microphone access is blocked. Enable Moss in macOS Privacy & Security > Microphone, then retry.",
      actionLabel: "Retry microphone access",
    };
  }
  if (
    input.captureErrorName === "NotFoundError" ||
    input.captureErrorName === "DevicesNotFoundError"
  ) {
    return {
      status: "no-device",
      message: "No microphone is connected. Connect one, then retry.",
      actionLabel: "Refresh microphones",
    };
  }
  if (input.enumerationFailed || input.captureErrorName !== null) {
    return {
      status: "unavailable",
      message: "Microphones could not be checked. Close other audio apps, then retry.",
      actionLabel: "Retry microphone access",
    };
  }
  return {
    status: "permission-unchecked",
    message: "Allow microphone access to discover available inputs.",
    actionLabel: "Check microphone access",
  };
}
