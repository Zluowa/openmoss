import type { ProviderRuntimeEvent } from "@moss/contracts";
import { Effect, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mossPayFetch, resolveMossPayBaseUrl } from "./mossPayGateway";
import {
  describeMossServiceEntryChange,
  isMossConnectionLevelFailure,
  fetchViaMossServiceEntries,
  makeMossServiceEntryRouter,
  mossServiceEntryRouterFor,
  registerMossServiceEntryRouterForTest,
  reportMossLaneConnectionFailures,
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
    expect(new Set(probe.mock.calls.map(([url]) => url))).toEqual(
      new Set([
        "https://moss-models.comiction.cn/functions/v1/moss-model-gateway/healthz",
        "https://moss-cn-models.inkcomicai.com/functions/v1/moss-model-gateway/healthz",
      ]),
    );
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

  it("keeps the entry in use and reports the outage when nothing answers", async () => {
    const { router } = makeRouter(new Set(), { now: 0 });
    await expect(router.ensure()).resolves.toBe(PRIMARY);
    expect(router.allUnreachable()).toBe(true);
    await expect(router.reportConnectionFailure(PRIMARY)).resolves.toBe(PRIMARY);
    expect(router.allUnreachable()).toBe(true);
  });

  it("moves at once when the entry in use fails a real request, without asking it again", async () => {
    const reachable = new Set([PRIMARY_HOST, FALLBACK_HOST]);
    const clock = { now: 0 };
    const changes: MossServiceEntryChange[] = [];
    const unsubscribe = subscribeMossServiceEntryChanges((change) => changes.push(change));
    const { router, probe } = makeRouter(reachable, clock);
    await router.ensure();
    expect(router.current()).toBe(PRIMARY);
    const probesAfterFirstUse = probe.mock.calls.length;

    // The fallback's answer is unknown (first use stopped once the primary passed): ask it.
    clock.now = 1_000;
    await expect(router.reportConnectionFailure(PRIMARY)).resolves.toBe(FALLBACK);
    const asked = probe.mock.calls.slice(probesAfterFirstUse).map(([url]) => new URL(url).host);
    expect(asked).toEqual([FALLBACK_HOST]);
    // A failure reported for an entry no longer in use changes nothing and asks nothing.
    await expect(router.reportConnectionFailure(PRIMARY)).resolves.toBe(FALLBACK);
    expect(probe.mock.calls.length).toBe(probesAfterFirstUse + 1);
    unsubscribe();
    expect(changes).toHaveLength(1);
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

/**
 * A scripted probe: each host answers from its own sequence (the nth check of that host passes
 * when `script(n)` is true), so a run is the same every time.
 */
const scriptedProbe = (scripts: Record<string, (n: number) => boolean>) => {
  const counts = new Map<string, number>();
  return vi.fn(async (healthUrl: string) => {
    const host = new URL(healthUrl).host;
    const n = counts.get(host) ?? 0;
    counts.set(host, n + 1);
    return scripts[host]?.(n) ?? false;
  });
};

const MINUTE = 60_000;
/** One request in six gets through, as from a mainland network on 2026-11-13. */
const oneInSix = (n: number) => n % 6 === 1;
const always = () => true;

const stickyRouter = (
  scripts: Record<string, (n: number) => boolean>,
  entries: ReadonlyArray<string> = [PRIMARY, FALLBACK],
) => {
  const clock = { now: 0 };
  const changes: Array<MossServiceEntryChange & { readonly at: number }> = [];
  const unsubscribe = subscribeMossServiceEntryChanges((change) =>
    changes.push({ ...change, at: clock.now }),
  );
  const probe = scriptedProbe(scripts);
  const router = makeMossServiceEntryRouter({
    service: "CN model gateway",
    entries,
    healthUrl: mossModelGatewayHealthUrl,
    probe,
    now: () => clock.now,
  });
  /** The server's maintenance: every minute, check the entries when a check is due. */
  const runMinutes = async (minutes: number, each?: () => Promise<void>) => {
    for (let minute = 0; minute < minutes; minute += 1) {
      clock.now += MINUTE;
      await router.refreshIfDue();
      await each?.();
    }
  };
  return { clock, changes, unsubscribe, probe, router, runMinutes };
};

describe("sticky failover", () => {
  it("is not fooled by one lucky check at first use", async () => {
    // The primary's first check passes, its other two do not.
    const { router, unsubscribe } = stickyRouter({
      [PRIMARY_HOST]: (n) => n === 0,
      [FALLBACK_HOST]: always,
    });
    await expect(router.ensure()).resolves.toBe(FALLBACK);
    unsubscribe();
  });

  it("settles on the fallback beside a one-in-six primary and stays through a day of checks", async () => {
    const { router, changes, unsubscribe, probe, runMinutes } = stickyRouter({
      [PRIMARY_HOST]: oneInSix,
      [FALLBACK_HOST]: always,
    });
    await expect(router.ensure()).resolves.toBe(FALLBACK);
    await runMinutes(24 * 60);
    unsubscribe();
    expect(router.current()).toBe(FALLBACK);
    expect(changes.map(({ from, to }) => `${from} -> ${to}`)).toEqual([
      `${PRIMARY} -> ${FALLBACK}`,
    ]);
    // About one check per entry per five minutes, not one per minute.
    expect(probe.mock.calls.length).toBeLessThan(2 * (24 * 12 + 8));
  });

  it("stays on the fallback when a one-in-six primary also fails real requests", async () => {
    const { router, changes, unsubscribe, runMinutes } = stickyRouter({
      [PRIMARY_HOST]: oneInSix,
      [FALLBACK_HOST]: always,
    });
    await router.ensure();
    await runMinutes(12 * 60, async () => {
      // Every minute a real request is made on the entry in use; the primary resets it.
      if (router.current() === PRIMARY) await router.reportConnectionFailure(PRIMARY);
    });
    unsubscribe();
    expect(router.current()).toBe(FALLBACK);
    expect(changes).toHaveLength(1);
  });

  it("returns to a primary that recovered, after the cool-down and four good checks a minute apart", async () => {
    let primaryUp = false;
    const { router, changes, unsubscribe, runMinutes } = stickyRouter({
      [PRIMARY_HOST]: () => primaryUp,
      [FALLBACK_HOST]: always,
    });
    await expect(router.ensure()).resolves.toBe(FALLBACK);
    primaryUp = true;
    // The primary failed at minute 0: suspect until minute 30, then good checks at 30, 31, 32
    // and 33. Its good checks during the cool-down (minutes 5 to 25) do not count.
    await runMinutes(32);
    expect(router.current()).toBe(FALLBACK);
    await runMinutes(1);
    unsubscribe();
    expect(router.current()).toBe(PRIMARY);
    expect(changes.map(({ to, at }) => [to, at / MINUTE])).toEqual([
      [FALLBACK, 0],
      [PRIMARY, 33],
    ]);
  });

  it("restarts the count when one check on the way back fails", async () => {
    let primaryUp = false;
    let failOnce = false;
    const { router, changes, unsubscribe, runMinutes } = stickyRouter({
      [PRIMARY_HOST]: () => {
        if (failOnce) {
          failOnce = false;
          return false;
        }
        return primaryUp;
      },
      [FALLBACK_HOST]: always,
    });
    await router.ensure();
    primaryUp = true;
    await runMinutes(31); // good checks at 30 and 31
    failOnce = true;
    await runMinutes(1); // fails at 32: suspect again until 62
    await runMinutes(32); // good checks at 62, 63, 64 (counts 1 to 3)
    expect(router.current()).toBe(FALLBACK);
    await runMinutes(1); // the fourth, at 65
    unsubscribe();
    expect(router.current()).toBe(PRIMARY);
    expect(changes.at(-1)?.at).toBe(65 * MINUTE);
  });

  it("chooses a healthy primary at first use without extra delay", async () => {
    vi.useFakeTimers();
    try {
      const probe = vi.fn(
        (healthUrl: string) =>
          new Promise<boolean>((resolve) =>
            setTimeout(() => resolve(true), new URL(healthUrl).host === PRIMARY_HOST ? 100 : 900),
          ),
      );
      const router = makeMossServiceEntryRouter({
        service: "CN model gateway",
        entries: [PRIMARY, FALLBACK],
        healthUrl: mossModelGatewayHealthUrl,
        probe,
      });
      let chosen: string | undefined;
      void router.ensure().then((entry) => {
        chosen = entry;
      });
      // Every check starts at once, on its own connection.
      expect(probe).toHaveBeenCalledTimes(6);
      await vi.advanceTimersByTimeAsync(99);
      expect(chosen).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(chosen).toBe(PRIMARY);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports an outage, and stays, when every entry fails", async () => {
    const { router, changes, unsubscribe, runMinutes } = stickyRouter({});
    await expect(router.ensure()).resolves.toBe(PRIMARY);
    expect(router.allUnreachable()).toBe(true);
    await runMinutes(60, async () => {
      await router.reportConnectionFailure(router.current());
    });
    unsubscribe();
    expect(router.current()).toBe(PRIMARY);
    expect(router.allUnreachable()).toBe(true);
    expect(changes).toEqual([]);
  });

  it("changes entry at most once per cool-down unless the entry in use fails", async () => {
    const SECOND = "https://moss-cn-models-2.example.cn/functions/v1/moss-model-gateway/v1";
    const { router, changes, unsubscribe, runMinutes } = stickyRouter(
      { [PRIMARY_HOST]: always, [FALLBACK_HOST]: always, [new URL(SECOND).host]: always },
      [PRIMARY, FALLBACK, SECOND],
    );
    await router.ensure();
    await runMinutes(10);
    // Real requests fail on the primary at minute 10 and on the fallback at minute 20.
    await router.reportConnectionFailure(PRIMARY);
    await runMinutes(10);
    await router.reportConnectionFailure(FALLBACK);
    expect(router.current()).toBe(SECOND);
    // The primary is trusted again at minute 43, but the last change was at minute 20.
    await runMinutes(29);
    expect(router.current()).toBe(SECOND);
    await runMinutes(1);
    unsubscribe();
    expect(router.current()).toBe(PRIMARY);
    expect(changes.map(({ to, at }) => [to, at / MINUTE])).toEqual([
      [FALLBACK, 10],
      [SECOND, 20],
      [PRIMARY, 50],
    ]);
  });

  it("never returns to an earlier entry within a cool-down of the last change", async () => {
    // A primary that passes about half its checks, beside a healthy fallback, for two days.
    let seed = 7;
    const coin = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648 < 0.5;
    };
    const { router, changes, unsubscribe, runMinutes } = stickyRouter({
      [PRIMARY_HOST]: coin,
      [FALLBACK_HOST]: always,
    });
    await router.ensure();
    await runMinutes(48 * 60, async () => {
      if (router.current() === PRIMARY && !coin()) await router.reportConnectionFailure(PRIMARY);
    });
    unsubscribe();
    for (const [index, change] of changes.entries()) {
      const previous = changes[index - 1];
      if (change.to === PRIMARY && previous) {
        expect(change.at - previous.at).toBeGreaterThanOrEqual(30 * MINUTE);
      }
    }
    // Returns are rare: one needs half an hour of quiet and four good checks in a row.
    expect(changes.length).toBeLessThan(20);
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

describe("one request across the entries", () => {
  /** Both entries pass their health checks; the primary is in use. */
  const inUse = async () => {
    const router = makeMossServiceEntryRouter({
      service: "CN model gateway",
      entries: [PRIMARY, FALLBACK],
      healthUrl: mossModelGatewayHealthUrl,
      probe: async () => true,
    });
    await router.ensure();
    registerMossServiceEntryRouterForTest(router);
    return router;
  };
  const resetOn = (host: string) =>
    vi.fn(async (entry: string) => {
      if (new URL(entry).host === host) throw fetchFailed("ECONNRESET");
      return Response.json({ ok: true });
    });

  it("asks a read once more on the next entry and moves there", async () => {
    const router = await inUse();
    const send = resetOn(PRIMARY_HOST);
    const response = await fetchViaMossServiceEntries({
      entry: PRIMARY,
      send,
      retryOnNextEntry: true,
    });
    expect(response.ok).toBe(true);
    expect(send.mock.calls.map(([entry]) => entry)).toEqual([PRIMARY, FALLBACK]);
    expect(router.current()).toBe(FALLBACK);
  });

  it("never sends work twice: reports the failure and lets the next attempt use the next entry", async () => {
    const router = await inUse();
    const send = resetOn(PRIMARY_HOST);
    await expect(
      fetchViaMossServiceEntries({ entry: PRIMARY, send, retryOnNextEntry: false }),
    ).rejects.toThrow("fetch failed");
    expect(send).toHaveBeenCalledTimes(1);
    expect(router.current()).toBe(FALLBACK);
    // A credential issued before the move still names the primary; the entry in use is asked.
    await fetchViaMossServiceEntries({ entry: PRIMARY, send, retryOnNextEntry: false });
    expect(send.mock.calls.at(-1)?.[0]).toBe(FALLBACK);
  });

  it("does not report a long request's own timeout, nor anything that answered", async () => {
    const router = await inUse();
    const timedOut = vi.fn(async () => {
      throw timeout();
    });
    await expect(
      fetchViaMossServiceEntries({
        entry: PRIMARY,
        send: timedOut,
        retryOnNextEntry: true,
        timeoutIsConnectionFailure: false,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    const busy = vi.fn(async () => Response.json({ error: "busy" }, { status: 503 }));
    const answer = await fetchViaMossServiceEntries({
      entry: PRIMARY,
      send: busy,
      retryOnNextEntry: true,
    });
    expect(answer.status).toBe(503);
    expect(timedOut).toHaveBeenCalledTimes(1);
    expect(busy).toHaveBeenCalledTimes(1);
    expect(router.current()).toBe(PRIMARY);
  });

  it("leaves a gateway that is no router's entry alone", async () => {
    await inUse();
    const send = vi.fn(async () => {
      throw fetchFailed("ECONNRESET");
    });
    await expect(
      fetchViaMossServiceEntries({
        entry: "https://global.example/functions/v1/moss-model-gateway/v1",
        send,
        retryOnNextEntry: true,
      }),
    ).rejects.toThrow("fetch failed");
    expect(send).toHaveBeenCalledTimes(1);
    expect(mossServiceEntryRouterFor("https://global.example/v1")).toBeNull();
  });
});

describe("Moss lane turns that failed below HTTP", () => {
  const LANE = "moss-managed-codex";
  const turnFailed = (errorCode: string, overrides: Record<string, unknown> = {}) =>
    ({
      type: "turn.completed",
      eventId: "event-1",
      provider: "codex",
      providerInstanceId: LANE,
      threadId: "thread-1",
      createdAt: "2026-11-13T10:00:00.000Z",
      payload: { state: "failed", errorCode },
      ...overrides,
    }) as unknown as ProviderRuntimeEvent;

  const run = async (
    events: ReadonlyArray<ProviderRuntimeEvent>,
    laneUrl: string | null,
    primaryAnswers = true,
  ) => {
    let firstUse = true;
    const router = makeMossServiceEntryRouter({
      service: "CN model gateway",
      entries: [PRIMARY, FALLBACK],
      healthUrl: mossModelGatewayHealthUrl,
      probe: async (healthUrl) =>
        firstUse || primaryAnswers || new URL(healthUrl).host !== PRIMARY_HOST,
      failureRecheckMs: 0,
    });
    await router.ensure();
    firstUse = false;
    registerMossServiceEntryRouterForTest(router);
    const report = vi.spyOn(router, "recheck");
    const failure = vi.spyOn(router, "reportConnectionFailure");
    await Effect.runPromise(
      Effect.scoped(
        reportMossLaneConnectionFailures({
          events: Stream.fromIterable(events),
          gatewayBaseUrlOf: () => Effect.succeed(laneUrl),
        }).pipe(Effect.andThen(Effect.sleep("20 millis"))),
      ),
    );
    return { router, report, failure };
  };

  it("re-checks the lane's entry for Codex's connection-failure code; the checks decide", async () => {
    // The primary really fails its health check: Moss moves.
    const broken = await run([turnFailed("httpConnectionFailed")], PRIMARY, false);
    expect(broken.report).toHaveBeenCalledExactlyOnceWith(PRIMARY);
    expect(broken.router.current()).toBe(FALLBACK);
    // The code alone is not proof: a primary that passes its checks is kept and not marked.
    const healthy = await run([turnFailed("httpConnectionFailed")], PRIMARY, true);
    expect(healthy.report).toHaveBeenCalledExactlyOnceWith(PRIMARY);
    expect(healthy.failure).not.toHaveBeenCalled();
    expect(healthy.router.current()).toBe(PRIMARY);
  });

  it("ignores model errors, broken streams, other agents, and gateways no router lists", async () => {
    const { report } = await run(
      [
        turnFailed("responseStreamDisconnected"),
        turnFailed("server_overloaded"),
        turnFailed("httpConnectionFailed", { provider: "claudeAgent" }),
        turnFailed("httpConnectionFailed", {
          payload: { state: "completed", errorCode: "httpConnectionFailed" },
        }),
      ],
      PRIMARY,
    );
    expect(report).not.toHaveBeenCalled();
    const elsewhere = await run([turnFailed("httpConnectionFailed")], "https://api.example/v1");
    expect(elsewhere.report).not.toHaveBeenCalled();
  });
});
