import type { MossAccountSessionState, MossCloudAccountState } from "@synara/contracts";

export const unconfiguredMossCloudAccountState = {
  configured: false,
  authenticated: false,
  account: null,
  session: null,
  emailVerificationRequired: false,
  modelGatewayConfigured: false,
  authProvider: "supabase_google",
} satisfies MossCloudAccountState;

export const unconfiguredMossPhoneAccountState = {
  configured: false,
  authenticated: false,
  session: null,
  smsProvider: "aliyun",
  aliyunSmsConfigured: false,
} satisfies MossAccountSessionState;
