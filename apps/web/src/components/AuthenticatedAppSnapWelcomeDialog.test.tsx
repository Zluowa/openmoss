// FILE: AuthenticatedAppSnapWelcomeDialog.test.tsx
// Purpose: Prevent the AppSnap first-run dialog from covering Moss sign-in.

import type {
  MossAccountSessionId,
  MossAccountSessionState,
  MossAccountUserId,
  MossCloudAccountId,
  MossCloudAccountState,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  serverMossAccountSessionQueryOptions,
  serverMossCloudAccountStateQueryOptions,
} from "./auth/mossServerReactQuery";
import {
  AuthenticatedAppSnapWelcomeDialog,
  hasAuthenticatedMossAccount,
} from "./AuthenticatedAppSnapWelcomeDialog";

vi.mock("./AppSnapWelcomeDialog", () => ({
  AppSnapWelcomeDialog: () => <div data-appsnap-welcome="true" />,
}));

const TEST_TIMESTAMP = "2026-08-21T00:00:00.000Z";

function phoneAccountState(authenticated: boolean): MossAccountSessionState {
  return {
    configured: true,
    authenticated,
    session: authenticated
      ? {
          id: "phone-session" as MossAccountSessionId,
          user: {
            id: "phone-user" as MossAccountUserId,
            phoneNumber: "+8613800138000",
            displayName: "Test",
            role: "member",
            status: "active",
            createdAt: TEST_TIMESTAMP,
            updatedAt: TEST_TIMESTAMP,
            lastLoginAt: TEST_TIMESTAMP,
          },
          createdAt: TEST_TIMESTAMP,
          expiresAt: "2026-08-22T00:00:00.000Z",
          lastSeenAt: TEST_TIMESTAMP,
        }
      : null,
    smsProvider: "aliyun",
    aliyunSmsConfigured: true,
  };
}

function cloudAccountState(authenticated: boolean): MossCloudAccountState {
  const accountId = "cloud-account" as MossCloudAccountId;
  return {
    configured: true,
    authenticated,
    account: authenticated
      ? {
          id: accountId,
          email: "test@example.com",
          emailVerified: true,
          displayName: "Test",
          status: "active",
          createdAt: TEST_TIMESTAMP,
          updatedAt: TEST_TIMESTAMP,
          lastLoginAt: TEST_TIMESTAMP,
        }
      : null,
    session: authenticated
      ? {
          accountId,
          expiresAt: "2026-08-22T00:00:00.000Z",
          refreshedAt: TEST_TIMESTAMP,
        }
      : null,
    emailVerificationRequired: false,
    modelGatewayConfigured: true,
    authProvider: "supabase_google",
  };
}

function renderGate(input: { phoneAuthenticated: boolean; cloudAuthenticated: boolean }): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(
    serverMossAccountSessionQueryOptions().queryKey,
    phoneAccountState(input.phoneAuthenticated),
  );
  queryClient.setQueryData(
    serverMossCloudAccountStateQueryOptions().queryKey,
    cloudAccountState(input.cloudAuthenticated),
  );

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <AuthenticatedAppSnapWelcomeDialog />
    </QueryClientProvider>,
  );
}

describe("AuthenticatedAppSnapWelcomeDialog", () => {
  it("treats unresolved and signed-out account state as unauthenticated", () => {
    expect(hasAuthenticatedMossAccount({ phone: undefined, cloud: undefined })).toBe(false);
    expect(
      hasAuthenticatedMossAccount({
        phone: { authenticated: false },
        cloud: { authenticated: false },
      }),
    ).toBe(false);
  });

  it("does not mount the AppSnap introduction over sign-in", () => {
    expect(renderGate({ phoneAuthenticated: false, cloudAuthenticated: false })).toBe("");
  });

  it.each([
    { phoneAuthenticated: true, cloudAuthenticated: false },
    { phoneAuthenticated: false, cloudAuthenticated: true },
  ])("mounts after either Moss login authority authenticates", (accountState) => {
    expect(renderGate(accountState)).toContain('data-appsnap-welcome="true"');
  });
});
