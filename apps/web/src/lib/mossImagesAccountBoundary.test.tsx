// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  mossServerMutationKeys,
  mossServerQueryKeys,
} from "~/components/auth/mossServerReactQuery";
import {
  readMossImagesAccountBoundary,
  useMossImagesAccountBoundary,
} from "./mossImagesAccountBoundary";

afterEach(cleanup);
function fixture() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(mossServerQueryKeys.mossAccountSession(), {
    authenticated: true,
    session: { user: { id: "user-a" } },
    activeRealm: "cn",
  });
  client.setQueryData(mossServerQueryKeys.mossCloudAccountState(), {
    authenticated: false,
    account: null,
    activeRealm: "cn",
  });
  return client;
}

describe("image account boundary uses the existing auth cache", () => {
  it("reacts to identity and realm updates without a focus or catalog request", () => {
    const client = fixture();
    const { result } = renderHook(useMossImagesAccountBoundary, {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    const before = result.current.key;
    const previous = result.current;
    act(() =>
      client.setQueryData(mossServerQueryKeys.mossAccountSession(), {
        authenticated: true,
        session: { user: { id: "user-b" } },
        activeRealm: "cn",
      }),
    );
    expect(result.current.key).not.toBe(before);
    expect(previous.isCurrent()).toBe(false);
    const second = result.current.key;
    act(() =>
      client.setQueryData(mossServerQueryKeys.mossAccountSession(), {
        authenticated: true,
        session: { user: { id: "user-b" } },
        activeRealm: "global",
      }),
    );
    expect(result.current.key).not.toBe(second);
  });

  it("invalidates a captured lease as soon as an account switch begins", async () => {
    const client = fixture();
    const { result } = renderHook(useMossImagesAccountBoundary, {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    const oldLease = result.current;
    let complete!: () => void;
    const mutation = client.getMutationCache().build(client, {
      mutationKey: mossServerMutationKeys.mossCloudSelect(),
      mutationFn: () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    });
    let pending!: Promise<void>;
    await act(async () => {
      pending = mutation.execute(undefined);
    });
    expect(result.current.transitioning).toBe(true);
    expect(oldLease.isCurrent()).toBe(false);
    await act(async () => {
      complete();
      await pending;
    });
    expect(result.current.transitioning).toBe(false);
  });

  it("does not include secrets or churn when only session refresh metadata changes", () => {
    const client = fixture();
    const before = readMossImagesAccountBoundary(client);
    client.setQueryData(mossServerQueryKeys.mossAccountSession(), {
      authenticated: true,
      session: { user: { id: "user-a" }, accessToken: "secret-token", lastSeenAt: "new-time" },
      activeRealm: "cn",
    });
    expect(readMossImagesAccountBoundary(client)).toBe(before);
    expect(before).not.toContain("secret-token");
    client.setQueryData(["unrelated", "image-preference"], "changed");
    expect(readMossImagesAccountBoundary(client)).toBe(before);
    client.removeQueries({ queryKey: mossServerQueryKeys.mossAccountSession() });
    expect(readMossImagesAccountBoundary(client)).not.toBe(before);
  });
});
