import type { MossCloudGoogleOAuthFlowId } from "@synara/contracts";

export const MOSS_CLOUD_PASSWORD_MIN_LENGTH = 8;
export const MOSS_CLOUD_PASSWORD_MAX_LENGTH = 128;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GOOGLE_OAUTH_FLOW_ID_PATTERN = /^[A-Za-z0-9._~-]{32,512}$/u;

export type MossCloudAuthField = "displayName" | "email" | "password" | "confirmPassword";

export type MossCloudAuthFieldErrors = Partial<Record<MossCloudAuthField, string | undefined>>;

export interface MossCloudCredentials {
  readonly email: string;
  readonly password: string;
}

export interface MossCloudSignUpValues extends MossCloudCredentials {
  readonly displayName: string;
}

export interface MossCloudPasswordValues {
  readonly password: string;
  readonly confirmPassword: string;
}

export interface MossCloudAuthRouteSearch {
  readonly code?: string;
  readonly flowId?: MossCloudGoogleOAuthFlowId;
  readonly email?: string;
  readonly type?: "recovery" | "verify";
}

export function normalizeMossCloudEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function validateMossCloudEmail(value: string): string | undefined {
  const email = normalizeMossCloudEmail(value);
  if (!email) return "Enter your email address.";
  if (email.length > 320 || !EMAIL_PATTERN.test(email)) {
    return "Enter a valid email address.";
  }
  return undefined;
}

export function validateMossCloudPassword(value: string): string | undefined {
  if (value.length < MOSS_CLOUD_PASSWORD_MIN_LENGTH) {
    return `Use at least ${MOSS_CLOUD_PASSWORD_MIN_LENGTH} characters.`;
  }
  if (value.length > MOSS_CLOUD_PASSWORD_MAX_LENGTH) {
    return `Use no more than ${MOSS_CLOUD_PASSWORD_MAX_LENGTH} characters.`;
  }
  return undefined;
}

export function validateMossCloudSignIn(values: MossCloudCredentials): MossCloudAuthFieldErrors {
  return {
    email: validateMossCloudEmail(values.email),
    password: values.password ? undefined : "Enter your password.",
  };
}

export function validateMossCloudSignUp(values: MossCloudSignUpValues): MossCloudAuthFieldErrors {
  const displayName = values.displayName.trim();
  return {
    displayName: displayName.length > 80 ? "Use no more than 80 characters." : undefined,
    email: validateMossCloudEmail(values.email),
    password: validateMossCloudPassword(values.password),
  };
}

export function validateMossCloudPasswordUpdate(
  values: MossCloudPasswordValues,
): MossCloudAuthFieldErrors {
  const passwordError = validateMossCloudPassword(values.password);
  return {
    password: passwordError,
    confirmPassword:
      !passwordError && values.confirmPassword !== values.password
        ? "Passwords do not match."
        : undefined,
  };
}

export function hasMossCloudAuthFieldErrors(errors: MossCloudAuthFieldErrors): boolean {
  return Object.values(errors).some((error) => Boolean(error));
}

export function parseMossCloudAuthRouteSearch(search: unknown): MossCloudAuthRouteSearch {
  if (!search || typeof search !== "object") return {};
  const record = search as Record<string, unknown>;
  const rawCode = typeof record.code === "string" ? record.code.trim() : "";
  const code = rawCode.length <= 4_096 ? rawCode : "";
  const rawFlowId = typeof record.flowId === "string" ? record.flowId.trim() : "";
  const flowId = GOOGLE_OAUTH_FLOW_ID_PATTERN.test(rawFlowId)
    ? (rawFlowId as MossCloudGoogleOAuthFlowId)
    : "";
  const rawEmail = typeof record.email === "string" ? record.email.trim() : "";
  const email = rawEmail.length <= 320 ? rawEmail : "";
  const type = record.type === "recovery" || record.type === "verify" ? record.type : undefined;
  return {
    ...(code ? { code } : {}),
    ...(flowId ? { flowId } : {}),
    ...(email ? { email } : {}),
    ...(type ? { type } : {}),
  };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.toLowerCase();
  if (typeof error === "string") return error.toLowerCase();
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code : "";
    const message = typeof record.message === "string" ? record.message : "";
    return `${code} ${message}`.toLowerCase();
  }
  return "";
}

export type MossCloudAuthErrorContext =
  | "signIn"
  | "signUp"
  | "exchangeCode"
  | "googleOAuth"
  | "updatePassword"
  | "account";

export function mossCloudAuthErrorMessage(
  error: unknown,
  context: MossCloudAuthErrorContext,
): string {
  const text = errorText(error);

  if (text.includes("not_configured") || text.includes("not configured")) {
    return "Moss account sign-in isn’t available right now.";
  }
  if (text.includes("rate_limited") || text.includes("rate limit")) {
    return "Too many attempts. Wait a moment, then try again.";
  }
  if (text.includes("network_error") || text.includes("network")) {
    return "Couldn’t connect to Moss. Check your connection and try again.";
  }
  if (text.includes("account_disabled") || text.includes("disabled")) {
    return "This account is disabled. Contact Moss support.";
  }
  if (text.includes("email_not_verified") || text.includes("not verified")) {
    return "Verify your email before signing in.";
  }
  if (
    text.includes("invalid_credentials") ||
    text.includes("invalid credentials") ||
    text.includes("email or password is incorrect")
  ) {
    return "Email or password is incorrect.";
  }
  if (text.includes("session_expired") || text.includes("authentication_required")) {
    if (context === "exchangeCode") {
      return "This password reset link is invalid or has expired. Request a new link.";
    }
    if (context === "googleOAuth") {
      return "This Google sign-in request is invalid or has expired. Start again.";
    }
    return "Your Moss session has expired. Sign in again.";
  }

  switch (context) {
    case "signIn":
      return "Moss could not sign you in. Check your details and try again.";
    case "signUp":
      return "Moss could not create the account. Try again in a moment.";
    case "exchangeCode":
      return "This password reset link is invalid or has expired. Request a new link.";
    case "googleOAuth":
      return "Moss could not complete Google sign-in. Try again.";
    case "updatePassword":
      return "Moss could not update your password. Try again.";
    case "account":
      return "Moss could not load your account. Try again.";
  }
}
