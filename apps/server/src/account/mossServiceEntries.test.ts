import { afterEach, describe, expect, it, vi } from "vitest";

import { mossPayFetch, resolveMossPayBaseUrl } from "./mossPayGateway";
import {
  describeMossServiceEntryChange,
  isMossConnectionLevelFailure,
  makeMossServiceEntryRouter,
  mossCnModelGatewayEntries,
  mossCnPayEntries,
  mossModelGatewayHealthUrl,
  mossPayHealthUrl,
  resetMossServiceEntryRoutersForTest,
  subscribeMossServiceEntryChanges,
  type MossServiceEntryChange,
} from "./mossServiceEntries";

const PRIMARY = "https://moss-models.comiction.cn/functions/v1/moss-model-gateway/v1";
const FALLBACK = "https://moss-cn-models.inkcomicai.com/functions/v1/moss-model-gateway/v1";
const PAY_PRIMARY = "https://moss-pay.comiction.cn/functions/v1/moss-pay";
const PAY_FALLBACK = "https://moss-cn-models.inkcomicai.com/functions/v1/moss-pay";

/** What undici throws for a failure below HTTP: `TypeError: fetch failed` with the cause. */
const fetchFailed = (code: string) =>
  Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error(code), { code }),
  });

const timeout = () =>
  Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });

/** A probe answering from a table of reachable hosts. */
const probeFrom = (reachable: Set<string>) =>
  vi.fn(async (healthUrl: string) => reachable.has(new URL(healthUrl).host));

const makeRouter = (reachable: Set<string>, clock: { now: number }) => {
  const probe = probeFrom(reachable);
  const router = makeMossServiceEntryRouter({
    service: "CN model gateway",
    entries: [PRIMARY, FALLBACK],
    healthUrl: mossModelGatewayHealthUrl,
    probe,
    now: () => clock.now,
  });
  return { router, probe };
};

const PRIMARY_HOST = "moss-models.comiction.cn";
const FALLBACK_HOST = "moss-cn-models.inkcomicai.com";

afterEach(() => {
  resetMossServiceEntryRoutersForTest();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("which entry Moss uses", () => {
  it("keeps the primary while it answers, and probes only the health URLs", async () => {
    const { router, probe } = makeRouter(new Set([PRIMARY_HOST, FALLBACK_HOST]), { now: 0 });
    expect(router.current()).toBe(PRIMARY);
    await expect(router.ensure()).resolves.toBe(PRIMARY);
    expect(probe.mock.calls.map(([url]) => url)).toEqual([
      "https://moss-models.comiction.cn/functions/v1/moss-model-gateway/healthz",
      "https://moss-cn-models.inkcomicai.com/functions/v1/moss-model-gateway/healthz",
    ]);
  });

  it("moves to the fallback when the primary cannot be reached, and says so once", async () => {
    const changes: MossServiceEntryChange[] = [];
    const unsubscribe = subscribeMossServiceEntryChanges((change) => changes.push(change));
    const { router } = makeRouter(new Set([FALLBACK_HOST]), { now: 0 });
    await expect(router.ensure()).resolves.toBe(FALLBACK);
    // The choice is remembered: later calls neither probe nor change it.
    await expect(router.ensure()).resolves.toBe(FALLBACK);
    unsubscribe();
    expect(changes).toEqual([{ service: "CN model gateway", from: PRIMARY, to: FALLBACK }]);
    expect(describeMossServiceEntryChange(changes[0]!)).toBe(
      "Moss CN model gateway entry changed: moss-models.comiction.cn -> moss-cn-models.inkcomicai.com",
    );
  });

  it("returns to the primary once a later check finds it working again", async () => {
    const reachable = new Set([FALLBACK_HOST]);
    const clock = { now: 0 };
    const { router } = makeRouter(reachable, clock);
    await router.ensure();
    expect(router.current()).toBe(FALLBACK);

    reachable.add(PRIMARY_HOST);
    clock.now = 60_000;
    await router.refreshIfDue();
    expect(router.current()).toBe(FALLBACK);

    clock.now = 5 * 60_000;
    await router.refreshIfDue();
    expect(router.current()).toBe(PRIMARY);
  });

  it("keeps the entry in use and reports the outage when nothing answers", async () => {
    const { router } = makeRouter(new Set(), { now: 0 });
    await expect(router.ensure()).resolves.toBe(PRIMARY);
    expect(router.allUnreachable()).toBe(true);
  });

  it("re-checks after a reported failure, but not on every failed request", async () => {
    const reachable = new Set([PRIMARY_HOST, FALLBACK_HOST]);
    const clock = { now: 0 };
    const { router, probe } = makeRouter(reachable, clock);
    await router.ensure();
    reachable.delete(PRIMARY_HOST);

    clock.now = 1_000;
    await expect(router.reportConnectionFailure(PRIMARY)).resolves.toBe(PRIMARY);
    expect(probe).toHaveBeenCalledTimes(2);

    clock.now = 20_000;
    await expect(router.reportConnectionFailure(PRIMARY)).resolves.toBe(FALLBACK);
    // A failure reported for an entry no longer in use changes nothing.
    await expect(router.reportConnectionFailure(PRIMARY)).resolves.toBe(FALLBACK);
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it("never probes a service with a single entry", async () => {
    const probe = vi.fn(async () => false);
    const router = makeMossServiceEntryRouter({
      service: "CN model gateway",
      entries: [PRIMARY],
      healthUrl: mossModelGatewayHealthUrl,
      probe,
    });
    await expect(router.ensure()).resolves.toBe(PRIMARY);
    await expect(router.reportConnectionFailure(PRIMARY)).resolves.toBe(PRIMARY);
    expect(probe).not.toHaveBeenCalled();
  });

  it("counts a timed-out health check as unreachable", async () => {
    vi.useFakeTimers();
    try {
      const router = makeMossServiceEntryRouter({
        service: "CN model gateway",
        entries: [PRIMARY, FALLBACK],
        healthUrl: mossModelGatewayHealthUrl,
        probeTimeoutMs: 4_000,
        probe: (healthUrl, signal) =>
          new URL(healthUrl).host === PRIMARY_HOST
            ? new Promise((resolve) => signal.addEventListener("abort", () => resolve(false)))
            : Promise.resolve(true),
      });
      const chosen = router.ensure();
      await vi.advanceTimersByTimeAsync(4_000);
      await expect(chosen).resolves.toBe(FALLBACK);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("what counts as a connection-level failure", () => {
  it.each([
    ["reset", fetchFailed("ECONNRESET")],
    ["refused", fetchFailed("ECONNREFUSED")],
    ["connect timeout", fetchFailed("UND_ERR_CONNECT_TIMEOUT")],
    ["request timeout", timeout()],
    ["TLS failure", fetchFailed("ERR_TLS_CERT_ALTNAME_INVALID")],
    ["certificate failure", fetchFailed("UNABLE_TO_VERIFY_LEAF_SIGNATURE")],
    ["DNS failure", fetchFailed("ENOTFOUND")],
    ["DNS retry", fetchFailed("EAI_AGAIN")],
    ["Bun reset", Object.assign(new Error("reset"), { code: "ECONNRESET" })],
    ["Bun refused", Object.assign(new Error("refused"), { code: "ConnectionRefused" })],
  ])("%s moves to the next entry", (_name, cause) => {
    expect(isMossConnectionLevelFailure(cause)).toBe(true);
  });

  it.each([
    ["a redirect refused by redirect: error", new TypeError("unexpected redirect")],
    ["a bad body", new SyntaxError("Unexpected token")],
    ["nothing", undefined],
  ])("%s does not", (_name, cause) => {
    expect(isMossConnectionLevelFailure(cause)).toBe(false);
  });
});

describe("the configured CN entries", () => {
  it("lists the primary, then its fallbacks, and only trusted ones", () => {
    const router = mossCnModelGatewayEntries({
      MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL: PRIMARY,
      MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_FALLBACK_URLS: `${FALLBACK}, http://127.0.0.1:1/functions/v1/moss-model-gateway/v1, https://elsewhere.example/other`,
    });
    expect(router.entries).toEqual([PRIMARY, FALLBACK]);
  });

  it("has no fallback when the primary is not configured", () => {
    const router = mossCnModelGatewayEntries({
      MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_FALLBACK_URLS: FALLBACK,
    });
    expect(router.entries).toEqual([]);
  });

  it("keeps payments on entries listed for payments, never a model entry", () => {
    const env = {
      MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL: PRIMARY,
      MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_FALLBACK_URLS: FALLBACK,
      MOSS_MEMFIRE_PHONE_PAY_BASE_URL: PAY_PRIMARY,
    };
    expect(mossCnPayEntries(env)?.entries).toEqual([PAY_PRIMARY]);
    expect(
      mossCnPayEntries({ ...env, MOSS_MEMFIRE_PHONE_PAY_FALLBACK_BASE_URLS: `${PAY_FALLBACK}/` })
        ?.entries,
    ).toEqual([PAY_PRIMARY, PAY_FALLBACK]);
    expect(
      mossCnPayEntries({ MOSS_MEMFIRE_PHONE_PAY_FALLBACK_BASE_URLS: PAY_FALLBACK }),
    ).toBeNull();
    expect(mossPayHealthUrl(PAY_FALLBACK)).toBe(`${PAY_FALLBACK}/healthz`);
  });
});

describe("CN payments across entries", () => {
  const payRouter = (reachable: Set<string>) =>
    makeMossServiceEntryRouter({
      service: "CN payment",
      entries: [PAY_PRIMARY, PAY_FALLBACK],
      healthUrl: mossPayHealthUrl,
      probe: probeFrom(reachable),
      failureRecheckMs: 0,
    });

  const payRequest = (method: "GET" | "POST", router: ReturnType<typeof payRouter>) =>
    mossPayFetch({
      realm: "memfire-phone",
      modelGatewayUrl: PRIMARY,
      accessToken: "phone-fixture-token",
      method,
      path: method === "GET" ? "/plans" : "/orders",
      ...(method === "POST" ? { body: { plan: "plus" } } : {}),
      phonePayEntries: router,
    });

  it("sends the first request to the entry that answers", async () => {
    const fetchMock = vi.fn(async () => Response.json({ plans: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await payRequest("POST", payRouter(new Set([FALLBACK_HOST])));
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`${PAY_FALLBACK}/orders`, expect.anything());
  });

  it("moves a read to the fallback when the primary resets mid-session", async () => {
    const reachable = new Set([new URL(PAY_PRIMARY).host, FALLBACK_HOST]);
    const router = payRouter(reachable);
    await router.ensure();
    reachable.delete(new URL(PAY_PRIMARY).host);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith(PAY_PRIMARY)) throw fetchFailed("ECONNRESET");
      return Response.json({ plans: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(payRequest("GET", router)).resolves.toEqual({ plans: [] });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${PAY_PRIMARY}/plans`,
      `${PAY_FALLBACK}/plans`,
    ]);
    expect(router.current()).toBe(PAY_FALLBACK);
  });

  it("resolves the payment entry in use, and only a listed one", () => {
    const env = {
      MOSS_MEMFIRE_PHONE_PAY_BASE_URL: PAY_PRIMARY,
      MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_FALLBACK_URLS: FALLBACK,
    };
    expect(resolveMossPayBaseUrl({ realm: "memfire-phone", modelGatewayUrl: FALLBACK }, env)).toBe(
      PAY_PRIMARY,
    );
  });

  it("never sends an order twice: the failed order reports, the next one uses the fallback", async () => {
    const reachable = new Set([new URL(PAY_PRIMARY).host, FALLBACK_HOST]);
    const router = payRouter(reachable);
    await router.ensure();
    reachable.delete(new URL(PAY_PRIMARY).host);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith(PAY_PRIMARY)) throw fetchFailed("ECONNRESET");
      return Response.json({ order: "o-1" });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(payRequest("POST", router)).rejects.toMatchObject({
      code: "gateway_unavailable",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(router.current()).toBe(PAY_FALLBACK);
    await expect(payRequest("POST", router)).resolves.toEqual({ order: "o-1" });
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(`${PAY_FALLBACK}/orders`);
  });

  it("does not move on an HTTP error from a healthy payment service", async () => {
    const router = payRouter(new Set([new URL(PAY_PRIMARY).host, FALLBACK_HOST]));
    const fetchMock = vi.fn(async () => Response.json({ error: "busy" }, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(payRequest("GET", router)).rejects.toMatchObject({ code: "gateway_error" });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`${PAY_PRIMARY}/plans`, expect.anything());
    expect(router.current()).toBe(PAY_PRIMARY);
  });
});
