import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  generateMossUpdateManifestKeyPair,
  signMossUpdateManifest,
} from "@moss/shared/mossUpdateMirror";

import {
  detectGreenToRedTransitions,
  ENDPOINT_SPECS,
  MANIFEST_SPECS,
  redactWatchdogText,
  runWatchdogOnce,
  TLS_HOSTS,
  type WatchdogStatusDocument,
} from "./moss-live-watchdog";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "moss-watchdog-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createSignedManifestFixtures() {
  const keys = generateMossUpdateManifestKeyPair();
  const desktopManifest = "version: 1.0.18\npath: Moss-1.0.18-x64.exe\n";
  const androidManifest = JSON.stringify({ version: "1.0.18", buildNumber: 10018 });
  return {
    publicKey: keys.manifestPublicKey,
    desktopManifest,
    desktopSig: signMossUpdateManifest({
      channelFile: "latest.yml",
      manifest: desktopManifest,
      privateKey: keys.privateKey,
    }),
    androidManifest,
    androidSig: signMossUpdateManifest({
      channelFile: "android-latest.json",
      manifest: androidManifest,
      privateKey: keys.privateKey,
    }),
  };
}

function makeHealthyHttpProbe(fixtures: ReturnType<typeof createSignedManifestFixtures>) {
  return vi.fn(async (input: { readonly url: string; readonly method: "GET" | "POST" }) => {
    if (input.url.endsWith("/v1/audio/transcriptions")) {
      return {
        ok: true,
        statusCode: 401,
        latencyMs: 22,
        body: JSON.stringify({ error: { code: "missing_access_token" } }),
      };
    }
    if (input.url.endsWith("/readyz")) {
      return {
        ok: true,
        statusCode: 200,
        latencyMs: 35,
        body: JSON.stringify({ ok: true, ready: true }),
      };
    }
    if (input.url.includes("devs.mossbotai.com")) {
      return {
        ok: true,
        statusCode: 200,
        latencyMs: 18,
        body: JSON.stringify({ service: "moss-devs-reports", protocol: 1 }),
      };
    }
    if (input.url.endsWith("desktop/latest.yml")) {
      return { ok: true, statusCode: 200, latencyMs: 40, body: fixtures.desktopManifest };
    }
    if (input.url.endsWith("desktop/latest.yml.sig")) {
      return { ok: true, statusCode: 200, latencyMs: 15, body: fixtures.desktopSig };
    }
    if (input.url.endsWith("android-latest.json")) {
      return { ok: true, statusCode: 200, latencyMs: 38, body: fixtures.androidManifest };
    }
    if (input.url.endsWith("android-latest.json.sig")) {
      return { ok: true, statusCode: 200, latencyMs: 14, body: fixtures.androidSig };
    }
    return {
      ok: true,
      statusCode: 200,
      latencyMs: 25,
      body: JSON.stringify({ ok: true }),
    };
  });
}

describe("MossLiveWatchdog", () => {
  it("writes atomic health-status.json, verifies Ed25519 manifests, and emits zero secrets", async () => {
    const dir = makeTempDir();
    const statusPath = join(dir, "health-status.json");
    const logPath = join(dir, "watchdog.log");
    const fixtures = createSignedManifestFixtures();
    const postBoardAlert = vi.fn(async (_input: { readonly message: string }) => undefined);

    const { status, alerted } = await runWatchdogOnce({
      now: () => Date.parse("2026-11-27T02:00:00Z"),
      proxyUrl: "http://127.0.0.1:7897",
      statusPath,
      logPath,
      manifestPublicKey: fixtures.publicKey,
      httpProbe: makeHealthyHttpProbe(fixtures),
      tlsProbe: async (host) => ({
        host,
        ok: true,
        expiresAt: "2027-02-01",
        daysRemaining: 66,
        level: "ok",
      }),
      postBoardAlert,
    });

    expect(alerted).toBe(false);
    expect(postBoardAlert).not.toHaveBeenCalled();
    expect(status.overall).toBe("ok");
    expect(status.checks).toHaveLength(ENDPOINT_SPECS.length + MANIFEST_SPECS.length);
    expect(status.tlsCerts).toHaveLength(TLS_HOSTS.length);
    expect(status.countdowns.map((c) => c.id)).toEqual(["tldraw", "cert", "cvm"]);
    expect(status.countdowns[0]?.daysRemaining).toBe(12); // 2026-11-27 -> 2026-12-08
    expect(status.countdowns[0]?.level).toBe("warn");

    const diskJson = JSON.parse(readFileSync(statusPath, "utf8")) as WatchdogStatusDocument;
    expect(diskJson.overall).toBe("ok");
    expect(diskJson.services).toHaveLength(7);
    const logText = readFileSync(logPath, "utf8");
    expect(logText).toContain("overall=ok checks=12/12");
  });

  it("alerts in plain Chinese on green -> red transition and does not duplicate red -> red", async () => {
    const dir = makeTempDir();
    const statusPath = join(dir, "health-status.json");
    const logPath = join(dir, "watchdog.log");
    const fixtures = createSignedManifestFixtures();
    const postBoardAlert = vi.fn(async (_input: { readonly message: string }) => undefined);
    const baseProbe = makeHealthyHttpProbe(fixtures);

    // 1. Healthy baseline
    await runWatchdogOnce({
      now: () => Date.parse("2026-11-27T02:00:00Z"),
      proxyUrl: null,
      statusPath,
      logPath,
      manifestPublicKey: fixtures.publicKey,
      httpProbe: baseProbe,
      tlsProbe: async (host) => ({
        host,
        ok: true,
        expiresAt: "2027-02-01",
        daysRemaining: 66,
        level: "ok",
      }),
      postBoardAlert,
    });

    // 2. Global realtime returns 503 + R2 desktop signature tampered -> green -> red
    const failingProbe = vi.fn(
      async (input: { readonly url: string; readonly method: "GET" | "POST" }) => {
        if (input.url.includes("rt-global.mossbotai.com")) {
          return {
            ok: true,
            statusCode: 503,
            latencyMs: 45,
            body: JSON.stringify({ ok: false, ready: false }),
          };
        }
        if (input.url === "https://update.mossbotai.com/desktop/latest.yml.sig") {
          return { ok: true, statusCode: 200, latencyMs: 12, body: "tampered-sig==" };
        }
        return baseProbe(input);
      },
    );

    const second = await runWatchdogOnce({
      now: () => Date.parse("2026-11-27T02:05:00Z"),
      proxyUrl: null,
      statusPath,
      logPath,
      manifestPublicKey: fixtures.publicKey,
      httpProbe: failingProbe,
      tlsProbe: async (host) => ({
        host,
        ok: true,
        expiresAt: "2027-02-01",
        daysRemaining: 66,
        level: "ok",
      }),
      postBoardAlert,
    });

    expect(second.status.overall).toBe("bad");
    expect(second.alerted).toBe(true);
    expect(second.transitions).toHaveLength(2);
    expect(postBoardAlert).toHaveBeenCalledTimes(1);
    expect(postBoardAlert.mock.calls[0]?.[0]?.message).toContain("线上巡检告警");

    // 3. Still red -> no duplicate alert
    const third = await runWatchdogOnce({
      now: () => Date.parse("2026-11-27T02:10:00Z"),
      proxyUrl: null,
      statusPath,
      logPath,
      manifestPublicKey: fixtures.publicKey,
      httpProbe: failingProbe,
      tlsProbe: async (host) => ({
        host,
        ok: true,
        expiresAt: "2027-02-01",
        daysRemaining: 66,
        level: "ok",
      }),
      postBoardAlert,
    });

    expect(third.alerted).toBe(false);
    expect(postBoardAlert).toHaveBeenCalledTimes(1);
  });

  it("redacts accidental tokens and treats overseas proxy-only reachability as ok", async () => {
    expect(redactWatchdogText("Bearer eyJhbGciOi.payload.sig moss_sk_abcdef12345")).toBe(
      "[REDACTED] [REDACTED]",
    );
    const dir = makeTempDir();
    const statusPath = join(dir, "health-status.json");
    const logPath = join(dir, "watchdog.log");
    const fixtures = createSignedManifestFixtures();
    const baseProbe = makeHealthyHttpProbe(fixtures);

    const { status } = await runWatchdogOnce({
      now: () => Date.parse("2026-11-27T02:00:00Z"),
      proxyUrl: "http://127.0.0.1:7897",
      statusPath,
      logPath,
      manifestPublicKey: fixtures.publicKey,
      httpProbe: async (input) => {
        if (input.proxyUrl === null && input.url.includes("supabase.co")) {
          return { ok: false, statusCode: null, latencyMs: 2000, body: "", error: "timeout" };
        }
        return baseProbe(input);
      },
      tlsProbe: async (host) => ({
        host,
        ok: true,
        expiresAt: "2027-02-01",
        daysRemaining: 66,
        level: "ok",
      }),
      postBoardAlert: async () => undefined,
    });

    expect(status.overall).toBe("ok");
    const globalChat = status.services.find((s) => s.id === "global-chat");
    expect(globalChat?.status).toBe("ok");
    expect(detectGreenToRedTransitions(status, status)).toEqual([]);
  });
});
