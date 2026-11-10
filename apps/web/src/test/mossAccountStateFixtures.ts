import type {
  MossAccountSessionState,
  MossCloudAccountState,
  MossEnterpriseKeyState,
} from "@moss/contracts";

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

export const unconfiguredMossEnterpriseKeyState = {
  configured: false,
  authenticated: false,
  keyPrefix: null,
  verifiedAt: null,
  modelCount: 0,
  active: false,
} satisfies MossEnterpriseKeyState;
