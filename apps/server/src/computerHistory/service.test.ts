import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  unlink,
  writeFile as writeNativeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { COMPUTER_HISTORY_RETENTION_MS, createTestHistoryKey } from "./store.ts";
import { parseChromeHistoryAdapterPayload } from "./browserAdapter.ts";
import {
  COMPUTER_HISTORY_SUGGESTION_WINDOW_MS,
  projectComputerHistoryEntryForModel,
} from "./summaryProjection.ts";
import type {
  ComputerHistoryRecursiveSummary,
  ComputerHistorySummaryBackend,
} from "./summaryJobs.ts";
import {
  COMPUTER_HISTORY_APP_ICON_MAX_DATA_URL_LENGTH,
  makeComputerHistoryService as makeActualComputerHistoryService,
} from "./service.ts";

const nativeHelperScripts = vi.hoisted(() => new Set<string>());

// Windows does not execute a .mjs shebang. Adapt only scripts written by this
// fixture to a real Node child; preserve the actual helper protocol and I/O.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const nativeArguments = (parameters: unknown[]): unknown[] => {
    const [command, args, ...rest] = parameters;
    if (
      process.platform !== "win32" ||
      typeof command !== "string" ||
      !nativeHelperScripts.has(command)
    ) {
      return parameters;
    }
    if (!Array.isArray(args)) throw new Error("Native helper fixture requires an argument array.");
    return [process.execPath, [command, ...args], ...rest];
  };
  const execFile = ((...parameters: unknown[]) =>
    Reflect.apply(actual.execFile, actual, nativeArguments(parameters))) as typeof actual.execFile;
  const custom = Symbol.for("nodejs.util.promisify.custom");
  const originalPromise = Reflect.get(actual.execFile, custom);
  if (typeof originalPromise !== "function")
    throw new Error("Native execFile promise adapter missing.");
  Object.defineProperty(execFile, custom, {
    value: (...parameters: unknown[]) =>
      Reflect.apply(originalPromise, actual.execFile, nativeArguments(parameters)),
  });
  return {
    ...actual,
    execFile,
    spawn: ((...parameters: unknown[]) =>
      Reflect.apply(actual.spawn, actual, nativeArguments(parameters))) as typeof actual.spawn,
  };
});

const writeFile: typeof writeNativeFile = async (file, data, options) => {
  await writeNativeFile(file, data, options);
  if (typeof file === "string" && file.endsWith(".mjs")) {
    const ownedRelativePath = relative(tmpdir(), file);
    if (isAbsolute(ownedRelativePath) || ownedRelativePath.startsWith("..")) {
      throw new Error("Native helper fixture must stay in its owned temporary directory.");
    }
    nativeHelperScripts.add(file);
  }
};

const fixtureServices = new Set<ReturnType<typeof makeActualComputerHistoryService>>();
function makeComputerHistoryService(
  ...parameters: Parameters<typeof makeActualComputerHistoryService>
) {
  const service = makeActualComputerHistoryService(...parameters);
  fixtureServices.add(service);
  return service;
}

afterEach(async () => {
  const failures: unknown[] = [];
  // Restart fixtures share one runtime marker; their owners must stop in order.
  for (const service of fixtureServices) {
    try {
      await service.setEnabled({ enabled: false });
    } catch (error) {
      failures.push(error);
    }
  }
  fixtureServices.clear();
  nativeHelperScripts.clear();
  if (failures.length > 0) {
    throw new AggregateError(failures, "History fixture cleanup failed.");
  }
});

const TEST_PNG_DATA_URL = `data:image/png;base64,${Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]).toString("base64")}`;

const settings = {
  consentAt: null,
  observation: {
    defaultApplicationBehavior: "allow" as const,
    defaultURLBehavior: "allow" as const,
    allowlist: [],
    blocklist: ["com.example.blocked"],
    urlAllowlist: [],
    urlBlocklist: ["blocked.example"],
  },
};

async function makeService() {
  const key = createTestHistoryKey();
  return makeComputerHistoryService({
    rootDir: await mkdtemp(join(tmpdir(), "moss-history-service-")),
    supported: true,
    permissions: {
      inputMonitoring: "granted",
      accessibility: "granted",
      screenRecording: "granted",
    },
    keyProvider: { getOrCreateKey: async () => key },
    now: () => 100_000,
  });
}

async function makePersistentService(rootDir: string, key: Buffer) {
  return makeComputerHistoryService({
    rootDir,
    supported: true,
    permissions: {
      inputMonitoring: "granted",
      accessibility: "granted",
      screenRecording: "granted",
    },
    keyProvider: { getOrCreateKey: async () => key },
    now: () => 100_000,
  });
}

async function pollUntil<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!predicate(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    value = await read();
  }
  return value;
}

describe("ComputerHistoryService", () => {
  it("parses browser mode independently from localized titles and fails closed on unknown mode", () => {
    expect(
      parseChromeHistoryAdapterPayload({
        mode: "normal",
        url: "https://example.test/",
        title: "無痕浏览 · 示例",
      }),
    ).toMatchObject({ privateBrowsing: false, mode: "normal" });
    expect(
      parseChromeHistoryAdapterPayload({
        mode: "incognito",
        url: "https://example.test/",
        title: "Privater Tab · Beispiel",
      }),
    ).toMatchObject({ privateBrowsing: true, mode: "incognito" });
    expect(
      parseChromeHistoryAdapterPayload({
        mode: "private",
        url: "https://example.test/",
        title: "Incognito",
      }),
    ).toBeNull();
    expect(
      parseChromeHistoryAdapterPayload({
        mode: undefined,
        url: "https://example.test/",
        title: "Normal",
      }),
    ).toBeNull();
  });

  it("requires consent and keeps disabled history off by default", async () => {
    const service = await makeService();
    const state = await service.getState();
    expect(state.enabled).toBe(false);
    expect(state.privateBrowsingExcluded).toBe(true);
    expect(state.captureCapability).toMatchObject({
      mode: "window_metadata_only",
      interactionEvents: false,
      activitySummaries: false,
    });
    await expect(service.setEnabled({ enabled: true })).rejects.toThrow(/consent/i);
  });

  it("applies independent app/url policies and excludes private browsing", async () => {
    const service = await makeService();
    await service.updateSettings({ settings });
    await service.setEnabled({ enabled: true, consentAt: "2026-08-19T00:00:00.000Z" });
    // The test source has no native helper, so an enabled service must not
    // claim that private-window exclusion is enforced by a constant flag.
    expect((await service.getState()).privateBrowsingExcluded).toBe(false);
    expect(
      await service.recordObservation({
        capturedAtMs: 1,
        app: { bundleIdentifier: "com.example.blocked", name: "Blocked" },
        window: {},
      }),
    ).toBe(false);
    expect(
      await service.recordObservation({
        capturedAtMs: 2,
        app: { bundleIdentifier: "com.example.editor", name: "Editor" },
        window: { url: "https://blocked.example/path" },
      } as never),
    ).toBe(false);
    expect(
      await service.recordObservation({
        capturedAtMs: 3,
        app: { bundleIdentifier: "com.google.Chrome", name: "Chrome" },
        window: { url: "https://example.com" },
      } as never),
    ).toBe(false);
    expect(
      await service.recordObservation({
        capturedAtMs: 4,
        app: { bundleIdentifier: "com.google.Chrome", name: "Chrome" },
        window: { url: "https://example.com/private" },
        privateBrowsing: true,
      } as never),
    ).toBe(false);
    expect(
      await service.recordObservation({
        capturedAtMs: 4.5,
        app: { bundleIdentifier: "com.google.Chrome", name: "Chrome" },
        window: { url: "https://example.com/unknown" },
      } as never),
    ).toBe(false);
    expect(
      await service.recordObservation({
        capturedAtMs: 5,
        app: { bundleIdentifier: "com.example.editor", name: "Editor" },
        window: {},
      }),
    ).toBe(true);
    expect(
      await service.recordObservation({
        capturedAtMs: 6,
        app: { bundleIdentifier: "com.apple.Safari", name: "Safari" },
        window: {},
      }),
    ).toBe(false);
    expect((await service.listHistory({ limit: 200 })).entries).toHaveLength(1);
  });

  it("supports deny-all include-only rules without coupling app and URL policy", async () => {
    const service = await makeService();
    await service.updateSettings({
      settings: {
        consentAt: null,
        observation: {
          defaultApplicationBehavior: "block",
          defaultURLBehavior: "block",
          allowlist: ["com.example.editor"],
          blocklist: [],
          urlAllowlist: ["allowed.example"],
          urlBlocklist: [],
        },
      },
    });
    await service.setEnabled({ enabled: true, consentAt: "2026-08-19T00:00:00.000Z" });
    expect(
      await service.recordObservation({
        capturedAtMs: 10,
        app: { bundleIdentifier: "com.example.editor", name: "Editor" },
        window: { url: "https://allowed.example/path" },
      } as never),
    ).toBe(false);
    expect(
      await service.recordObservation({
        capturedAtMs: 11,
        app: { bundleIdentifier: "com.example.other", name: "Other" },
        window: { url: "https://allowed.example/path" },
      } as never),
    ).toBe(false);
    expect(
      await service.recordObservation({
        capturedAtMs: 12,
        app: { bundleIdentifier: "com.example.editor", name: "Editor" },
        window: { url: "https://other.example/path" },
      } as never),
    ).toBe(false);
  });

  it("discovers a bounded application catalog before any history exists", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-apps-"));
    const helperPath = join(rootDir, "applications-helper.mjs");
    await writeFile(
      helperPath,
      `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({type:'history_applications',applications:[{bundleIdentifier:'com.example.editor',name:'Editor',iconDataURL:${JSON.stringify(TEST_PNG_DATA_URL)}}]})+'\\n');\n`,
      { mode: 0o700 },
    );
    await chmod(helperPath, 0o700);
    await chmod(helperPath, 0o700);
    const key = createTestHistoryKey();
    const service = makeComputerHistoryService({
      rootDir,
      supported: true,
      helperPath,
      keyProvider: { getOrCreateKey: async () => key },
    });
    expect(await service.listApplications()).toEqual({
      applications: [
        {
          bundleIdentifier: "com.example.editor",
          name: "Editor",
          permitted: true,
          isWebBrowser: false,
          iconDataURL: TEST_PNG_DATA_URL,
        },
      ],
    });
  });

  it("preserves native usage order ahead of applications cached from history", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-app-usage-order-"));
    const helperDir = await mkdtemp(join(tmpdir(), "moss-history-app-usage-helper-"));
    const helperPath = join(helperDir, "applications-helper.mjs");
    await writeFile(
      helperPath,
      `#!/usr/bin/env node\nif (process.argv.includes('--history-applications')) { process.stdout.write(JSON.stringify({type:'history_applications',applications:[{bundleIdentifier:'com.example.recent',name:'Recent'},{bundleIdentifier:'com.example.frequent',name:'Frequent'}]})+'\\n'); } else { process.stdout.write(JSON.stringify({type:'history_permissions',inputMonitoring:'granted',accessibility:'granted',screenRecording:'granted'})+'\\n'); setInterval(() => {}, 1000); }\n`,
      { mode: 0o700 },
    );
    const key = createTestHistoryKey();
    const service = makeComputerHistoryService({
      rootDir,
      supported: true,
      helperPath,
      permissions: {
        inputMonitoring: "granted",
        accessibility: "granted",
        screenRecording: "granted",
      },
      keyProvider: { getOrCreateKey: async () => key },
    });
    await service.setEnabled({ enabled: true, consentAt: "2026-08-21T00:00:00.000Z" });
    await service.recordObservation({
      capturedAtMs: Date.now(),
      app: { bundleIdentifier: "com.example.cached", name: "Cached" },
      window: {},
    });

    expect(
      (await service.listApplications()).applications.map((application) => application.name),
    ).toEqual(["Recent", "Frequent", "Cached"]);
    await service.setEnabled({ enabled: false });
  });

  it("omits invalid and oversized native app icons and does not rediscover a catalog", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-app-icon-bounds-"));
    const helperPath = join(rootDir, "applications-helper.mjs");
    const oversized = `data:image/png;base64,${"A".repeat(COMPUTER_HISTORY_APP_ICON_MAX_DATA_URL_LENGTH)}`;
    const oversizedBytes = `data:image/png;base64,${Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(128_001 - 8),
    ]).toString("base64")}`;
    await writeFile(
      helperPath,
      `#!/usr/bin/env node\nimport * as fs from 'node:fs';\nconst countFile = ${JSON.stringify(join(rootDir, "calls"))};\nconst count = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf8') : 0) + 1;\nfs.writeFileSync(countFile, String(count));\nprocess.stdout.write(JSON.stringify({type:'history_applications',applications:[{bundleIdentifier:'com.example.valid',name:'Valid',iconDataURL:${JSON.stringify(TEST_PNG_DATA_URL)}},{bundleIdentifier:'com.example.bad-scheme',name:'Bad scheme',iconDataURL:'data:image/svg+xml;base64,AAAA'},{bundleIdentifier:'com.example.oversized',name:'Oversized',iconDataURL:${JSON.stringify(oversized)}},{bundleIdentifier:'com.example.oversized-bytes',name:'Oversized bytes',iconDataURL:${JSON.stringify(oversizedBytes)}}]})+'\\n');\n`,
      { mode: 0o700 },
    );
    await chmod(helperPath, 0o700);
    await chmod(helperPath, 0o700);
    const service = makeComputerHistoryService({
      rootDir,
      supported: true,
      helperPath,
      keyProvider: { getOrCreateKey: async () => createTestHistoryKey() },
    });

    const first = await service.listApplications();
    expect(first.applications).toEqual([
      {
        bundleIdentifier: "com.example.valid",
        name: "Valid",
        permitted: true,
        isWebBrowser: false,
        iconDataURL: TEST_PNG_DATA_URL,
      },
      {
        bundleIdentifier: "com.example.bad-scheme",
        name: "Bad scheme",
        permitted: true,
        isWebBrowser: false,
      },
      {
        bundleIdentifier: "com.example.oversized",
        name: "Oversized",
        permitted: true,
        isWebBrowser: false,
      },
      {
        bundleIdentifier: "com.example.oversized-bytes",
        name: "Oversized bytes",
        permitted: true,
        isWebBrowser: false,
      },
    ]);
    const second = await service.listApplications();
    expect(second).toEqual(first);
    expect(await readFile(join(rootDir, "calls"), "utf8")).toBe("1");
  });

  it("resolves exact selected application metadata in caller order and marks browsers by registry", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-app-resolution-"));
    const helperPath = join(rootDir, "applications-helper.mjs");
    await writeFile(
      helperPath,
      `#!/usr/bin/env node
import * as fs from 'node:fs';
const countFile = ${JSON.stringify(join(rootDir, "calls"))};
const count = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf8') : 0) + 1;
fs.writeFileSync(countFile, String(count));
process.stdout.write(JSON.stringify({type:'history_applications',applications:[{bundleIdentifier:'com.example.editor',name:'Editor',iconDataURL:${JSON.stringify(TEST_PNG_DATA_URL)}},{bundleIdentifier:'com.google.Chrome',name:'Not a browser-shaped name'},{bundleIdentifier:'com.example.fake-browser',name:'Google Chrome'}]})+'\\n');
`,
      { mode: 0o700 },
    );
    const service = makeComputerHistoryService({
      rootDir,
      supported: true,
      helperPath,
      keyProvider: { getOrCreateKey: async () => createTestHistoryKey() },
    });

    await expect(
      service.resolveApplications({
        bundleIdentifiers: [
          "com.example.fake-browser",
          "com.google.Chrome",
          "com.unknown.missing",
          "com.example.fake-browser",
          "com.example.editor",
        ],
      }),
    ).resolves.toEqual({
      applications: [
        {
          bundleIdentifier: "com.example.fake-browser",
          name: "Google Chrome",
          permitted: true,
          isWebBrowser: false,
        },
        {
          bundleIdentifier: "com.google.Chrome",
          name: "Not a browser-shaped name",
          permitted: true,
          isWebBrowser: true,
        },
        {
          bundleIdentifier: "com.example.editor",
          name: "Editor",
          permitted: true,
          isWebBrowser: false,
          iconDataURL: TEST_PNG_DATA_URL,
        },
      ],
    });
    await expect(service.resolveApplications({ query: "chrome" })).resolves.toMatchObject({
      applications: [
        {
          bundleIdentifier: "com.google.Chrome",
          isWebBrowser: true,
        },
        {
          bundleIdentifier: "com.example.fake-browser",
          isWebBrowser: false,
        },
      ],
    });
    expect(await readFile(join(rootDir, "calls"), "utf8")).toBe("1");
  });

  it("promotes helper-learned browser capabilities without using display names", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-learned-browser-"));
    const helperPath = join(rootDir, "history-helper.mjs");
    await writeFile(
      helperPath,
      `#!/usr/bin/env node
const applications = [{bundleIdentifier:'com.example.learned',name:'Google Chrome'}];
if (process.argv.includes('--history-applications')) { process.stdout.write(JSON.stringify({type:'history_applications',applications})+'\\n'); process.exit(0); }
process.stdout.write(JSON.stringify({type:'history_permissions',inputMonitoring:'granted',accessibility:'granted',screenRecording:'granted'})+'\\n');
process.stdout.write(JSON.stringify({type:'history_browser_capabilities',browsers:[{bundleIdentifier:'com.example.learned',name:'Google Chrome',status:'unsupported',detail:'helper registry'}]})+'\\n');
setInterval(() => {}, 1000);
`,
      { mode: 0o700 },
    );
    const service = makeComputerHistoryService({
      rootDir,
      supported: true,
      helperPath,
      permissions: {
        inputMonitoring: "granted",
        accessibility: "granted",
        screenRecording: "granted",
      },
      keyProvider: { getOrCreateKey: async () => createTestHistoryKey() },
    });
    await expect(service.listApplications()).resolves.toMatchObject({
      applications: [
        {
          bundleIdentifier: "com.example.learned",
          name: "Google Chrome",
          isWebBrowser: false,
        },
      ],
    });
    await service.setEnabled({ enabled: true, consentAt: "2026-08-19T00:00:00.000Z" });
    let learned = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const application = (await service.listApplications()).applications[0];
      if (application?.isWebBrowser === true) {
        learned = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(learned).toBe(true);
    await service.setEnabled({ enabled: false });
  });

  it("marks every HistoryWatch browser variant before activation from the bundle registry", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-browser-registry-"));
    const helperPath = join(rootDir, "applications-helper.mjs");
    const applications = [
      ["com.google.Chrome.beta", "Chrome Beta"],
      ["com.apple.SafariTechnologyPreview", "Safari Technology Preview"],
      ["com.microsoft.edgemac.Dev", "Edge Dev"],
      ["org.mozilla.nightly", "Firefox Nightly"],
      ["com.example.fake-browser", "Firefox Nightly"],
    ].map(([bundleIdentifier, name]) => ({ bundleIdentifier, name }));
    await writeFile(
      helperPath,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({type:'history_applications',applications:${JSON.stringify(applications)}})+'\\n');
`,
      { mode: 0o700 },
    );
    const service = makeComputerHistoryService({
      rootDir,
      supported: true,
      helperPath,
      keyProvider: { getOrCreateKey: async () => createTestHistoryKey() },
    });

    await expect(service.listApplications()).resolves.toMatchObject({
      applications: [
        { bundleIdentifier: "com.google.Chrome.beta", isWebBrowser: true },
        { bundleIdentifier: "com.apple.SafariTechnologyPreview", isWebBrowser: true },
        { bundleIdentifier: "com.microsoft.edgemac.Dev", isWebBrowser: true },
        { bundleIdentifier: "org.mozilla.nightly", isWebBrowser: true },
        { bundleIdentifier: "com.example.fake-browser", isWebBrowser: false },
      ],
    });
  });

  it("discovers native icon metadata when the timeline is opened before the app picker", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-timeline-icon-"));
    const helperPath = join(rootDir, "applications-helper.mjs");
    const callsPath = join(rootDir, "application-calls");
    await writeFile(
      helperPath,
      `#!/usr/bin/env node\nimport * as fs from 'node:fs';\nconst application = {bundleIdentifier:'com.example.editor',name:'Editor',iconDataURL:${JSON.stringify(TEST_PNG_DATA_URL)}};\nif (process.argv.includes('--history-applications')) { const callsPath=${JSON.stringify(callsPath)}; const calls=Number(fs.existsSync(callsPath) ? fs.readFileSync(callsPath, 'utf8') : 0) + 1; fs.writeFileSync(callsPath, String(calls)); process.stdout.write(JSON.stringify({type:'history_applications',applications:[application]})+'\\n'); } else { process.stdout.write(JSON.stringify({type:'history_permissions',inputMonitoring:'unknown',accessibility:'unknown',screenRecording:'granted'})+'\\n'); setInterval(() => {}, 1000); }\n`,
      { mode: 0o700 },
    );
    const key = createTestHistoryKey();
    const service = makeComputerHistoryService({
      rootDir,
      supported: true,
      helperPath,
      permissions: {
        inputMonitoring: "granted",
        accessibility: "granted",
        screenRecording: "granted",
      },
      keyProvider: { getOrCreateKey: async () => key },
      now: () => 100_000,
    });

    await service.setEnabled({ enabled: true, consentAt: "2026-08-19T00:00:00.000Z" });
    await expect(
      service.recordObservation({
        capturedAtMs: 50_000,
        app: { bundleIdentifier: "com.example.editor", name: "Editor" },
        window: {},
      }),
    ).resolves.toBe(true);
    await expect(service.listHistory()).resolves.toMatchObject({
      entries: [
        {
          summaryLevel: "ten_minute",
          interval: {
            startMs: 0,
            endMs: 10 * 60 * 1_000,
          },
          applications: [
            {
              bundleIdentifier: "com.example.editor",
              displayName: "Editor",
              iconDataURL: TEST_PNG_DATA_URL,
            },
          ],
          memoryFilePath: expect.stringMatching(
            /[\\/]resources[\\/].*(?:-[a-z]{4}-10min-[a-z0-9-]+|-[a-f0-9]{16}-10min-memory-summary)\.md$/u,
          ),
        },
      ],
    });
    await expect(service.listApplications()).resolves.toMatchObject({
      applications: [{ bundleIdentifier: "com.example.editor", iconDataURL: TEST_PNG_DATA_URL }],
    });
    expect(await readFile(callsPath, "utf8")).toBe("1");
    await service.setEnabled({ enabled: false });
  });

  it("hydrates and materializes recursive local summary jobs with the recorder lifecycle", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-recursive-service-"));
    const key = createTestHistoryKey();
    const service = makeComputerHistoryService({
      rootDir,
      supported: true,
      permissions: {
        inputMonitoring: "granted",
        accessibility: "granted",
        screenRecording: "granted",
      },
      keyProvider: { getOrCreateKey: async () => key },
      now: () => 100_000,
    });
    await service.setEnabled({ enabled: true, consentAt: "2026-08-19T00:00:00.000Z" });
    await service.recordObservation({
      capturedAtMs: 1_000,
      app: { bundleIdentifier: "com.example.editor", name: "Editor" },
      window: { title: "Window title is not a job input" },
    });
    await service.pause();
    await service.resume();
    const resources = await readdir(join(rootDir, "resources"));
    expect(resources).toContain("summary-jobs-manifest.json");
    expect(resources.some((name) => /^1970-01-01T00-00-00-[a-z]{4}-10min-/u.test(name))).toBe(true);
    await service.pause();
    expect((await service.getState()).recorderState).toBe("paused");
    await service.resume();
    expect((await service.getState()).recorderState).toBe("running");
    await service.setEnabled({ enabled: false });
  });

  it("uses the current recursive projection for UI and model consumers", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-recursive-authority-"));
    const key = createTestHistoryKey();
    let backendCalls = 0;
    const recursiveBackend: ComputerHistorySummaryBackend = {
      async summarize(input): Promise<ComputerHistoryRecursiveSummary> {
        backendCalls += 1;
        return {
          logicalJobKey: `${input.kind}:${input.startMs}`,
          kind: input.kind,
          startMs: input.startMs,
          endMs: input.endMs,
          title: "Recursive canonical title",
          description: "Recursive canonical description",
          summaryText: "Recursive canonical title. Recursive canonical description",
          applications: ["RecursiveApp"],
          applicationBundleIdentifiers: ["com.example.recursive"],
          childJobKeys: input.childSummaries.map((child) => child.logicalJobKey),
        };
      },
    };
    const service = makeComputerHistoryService({
      rootDir,
      supported: true,
      permissions: {
        inputMonitoring: "granted",
        accessibility: "granted",
        screenRecording: "granted",
      },
      keyProvider: { getOrCreateKey: async () => key },
      now: () => 100_000,
      summaryJobOptions: { backend: recursiveBackend },
    });
    await service.setEnabled({ enabled: true, consentAt: "2026-08-19T00:00:00.000Z" });
    await service.recordObservation({
      capturedAtMs: 1_000,
      app: { bundleIdentifier: "com.example.editor", name: "Editor" },
      window: {},
    });
    expect(backendCalls).toBe(0);
    await service.pause();
    await service.resume();
    expect(backendCalls).toBe(1);
    const entry = (await service.listHistory()).entries[0];
    expect(entry).toMatchObject({
      title: "Recursive canonical title",
      description: "Recursive canonical description",
      applications: [{ bundleIdentifier: "com.example.recursive", displayName: "RecursiveApp" }],
      memoryFilePath: expect.stringMatching(/-[a-z]{4}-10min-recursive-canonical-title\.md$/u),
    });
    const modelEntry = projectComputerHistoryEntryForModel(entry!);
    expect(modelEntry).toMatchObject({
      title: "Recursive canonical title",
      description: "Recursive canonical description",
      applications: [{ bundleIdentifier: "com.example.recursive", displayName: "RecursiveApp" }],
    });
    await service.setEnabled({ enabled: false });
  });

  it("surfaces a scheduled summary failure and clears it after a later boundary succeeds", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-scheduled-health-"));
    const key = createTestHistoryKey();
    let shouldFail = true;
    let backendCalls = 0;
    const timers: Array<() => void> = [];
    const backend: ComputerHistorySummaryBackend = {
      async summarize(input): Promise<ComputerHistoryRecursiveSummary> {
        backendCalls += 1;
        if (shouldFail) throw new Error("scheduled failure");
        return {
          logicalJobKey: `${input.kind}:${input.startMs}`,
          kind: input.kind,
          startMs: input.startMs,
          endMs: input.endMs,
          title: "Recovered",
          description: "Recovered description",
          summaryText: "Recovered. Recovered description",
          applications: ["Editor"],
          applicationBundleIdentifiers: ["com.example.editor"],
          childJobKeys: input.childSummaries.map((child) => child.logicalJobKey),
        };
      },
    };
    const service = makeComputerHistoryService({
      rootDir,
      supported: true,
      permissions: {
        inputMonitoring: "granted",
        accessibility: "granted",
        screenRecording: "granted",
      },
      keyProvider: { getOrCreateKey: async () => key },
      now: () => 0,
      summaryJobOptions: {
        backend,
        setTimer: (handler) => {
          timers.push(handler);
          return handler;
        },
        clearTimer: () => undefined,
      },
    });
    await service.setEnabled({ enabled: true, consentAt: "2026-08-19T00:00:00.000Z" });
    await service.recordObservation({
      capturedAtMs: 1_000,
      app: { bundleIdentifier: "com.example.editor", name: "Editor" },
      window: {},
    });
    timers[0]!();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await service.getState()).health.lastError).toMatch(/summary resources/i);
    shouldFail = false;
    expect(timers.length).toBeGreaterThanOrEqual(4);
    timers[3]!();
    await vi.waitFor(
      async () => {
        expect(backendCalls).toBe(2);
        expect((await service.getState()).health.lastError).toBeNull();
      },
      { timeout: 2_000 },
    );
    await service.setEnabled({ enabled: false });
  });

  it("falls back to the legacy resource when a recursive file disappears", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-recursive-fallback-"));
    const key = createTestHistoryKey();
    const service = makeComputerHistoryService({
      rootDir,
      supported: true,
      permissions: {
        inputMonitoring: "granted",
        accessibility: "granted",
        screenRecording: "granted",
      },
      keyProvider: { getOrCreateKey: async () => key },
      now: () => 100_000,
    });
    await service.setEnabled({ enabled: true, consentAt: "2026-08-19T00:00:00.000Z" });
    await service.recordObservation({
      capturedAtMs: 1_000,
      app: { bundleIdentifier: "com.example.editor", name: "Editor" },
      window: {},
    });
    await service.pause();
    await service.resume();
    const recursiveEntry = (await service.listHistory()).entries[0];
    expect(recursiveEntry?.memoryFilePath).toMatch(/-[a-z]{4}-10min-[a-z0-9-]+\.md$/u);
    const deletedRecursivePath = recursiveEntry!.memoryFilePath;
    await unlink(deletedRecursivePath);
    const fallbackEntry = (await service.listHistory()).entries[0];
    expect(fallbackEntry).toBeDefined();
    expect(fallbackEntry?.memoryFilePath).not.toBe(deletedRecursivePath);
    await expect(stat(fallbackEntry!.memoryFilePath)).resolves.toBeDefined();
    expect(fallbackEntry?.memoryFilePath).toMatch(/-[a-f0-9]{16}-10min-memory-summary\.md$/u);
    await service.setEnabled({ enabled: false });
  });

  it("revokes stale recursive content on paused and stopped partial clears, then rebuilds kept data", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-partial-clear-"));
    const key = createTestHistoryKey();
    const service = makeComputerHistoryService({
      rootDir,
      supported: true,
      permissions: {
        inputMonitoring: "granted",
        accessibility: "granted",
        screenRecording: "granted",
      },
      keyProvider: { getOrCreateKey: async () => key },
      now: () => 100_000,
    });
    await service.setEnabled({ enabled: true, consentAt: "2026-08-19T00:00:00.000Z" });
    await service.recordObservation({
      capturedAtMs: 1_000,
      app: { bundleIdentifier: "com.example.first", name: "First" },
      window: {},
    });
    await service.recordObservation({
      capturedAtMs: 2_000,
      app: { bundleIdentifier: "com.example.second", name: "Second" },
      window: {},
    });
    await service.pause();
    await service.resume();
    const before = (await service.listHistory()).entries[0];
    expect(before?.applications.map((application) => application.displayName)).toEqual([
      "First",
      "Second",
    ]);

    await service.pause();
    await service.clearHistory({
      scope: "last_10m",
      intervalStartMs: 2_000,
      intervalEndMs: 2_000,
    });
    const pausedAfterClear = (await service.listHistory()).entries[0];
    expect(pausedAfterClear?.applications.map((application) => application.displayName)).toEqual([
      "First",
    ]);
    expect(pausedAfterClear?.memoryFilePath).toMatch(/-[a-f0-9]{16}-10min-memory-summary\.md$/u);
    await service.resume();
    const resumed = (await service.listHistory()).entries[0];
    expect(resumed?.applications.map((application) => application.displayName)).toEqual(["First"]);
    expect(resumed?.memoryFilePath).toMatch(/-[a-z]{4}-10min-[a-z0-9-]+\.md$/u);

    await service.setEnabled({ enabled: false });
    await service.recordAccessAudit({
      tool: "history_query",
      callerThreadId: "partial-clear-stopped",
      callerProvider: "local",
      resultCount: 1,
    });
    await service.setEnabled({ enabled: true, consentAt: "2026-08-19T00:00:00.000Z" });
    await service.recordObservation({
      capturedAtMs: 61_000,
      app: { bundleIdentifier: "com.example.third", name: "Third" },
      window: {},
    });
    await service.pause();
    await service.resume();
    await service.setEnabled({ enabled: false });
    await service.clearHistory({
      scope: "last_10m",
      intervalStartMs: 61_000,
      intervalEndMs: 61_000,
    });
    const stoppedAfterClear = (await service.listHistory()).entries;
    expect(stoppedAfterClear).toHaveLength(1);
    expect(
      stoppedAfterClear[0]?.applications.map((application) => application.displayName),
    ).toEqual(["First"]);
    await service.setEnabled({ enabled: true, consentAt: "2026-08-19T00:00:00.000Z" });
    const rebuiltAfterStoppedClear = (await service.listHistory()).entries;
    expect(rebuiltAfterStoppedClear).toHaveLength(1);
    expect(
      rebuiltAfterStoppedClear[0]?.applications.map((application) => application.displayName),
    ).toEqual(["First"]);
    await service.setEnabled({ enabled: false });
  });

  it("keeps a clear-time rebuild failure from re-exposing deleted recursive content", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-clear-lkg-"));
    const key = createTestHistoryKey();
    const randomValues = ["oldx", "newx"];
    const backend: ComputerHistorySummaryBackend = {
      async summarize(input): Promise<ComputerHistoryRecursiveSummary> {
        const applications = input.minuteInputs[0]?.applications.length
          ? [...input.minuteInputs[0].applications]
          : ["Summary"];
        const title = applications.join("-");
        return {
          logicalJobKey: `${input.kind}:${input.startMs}`,
          kind: input.kind,
          startMs: input.startMs,
          endMs: input.endMs,
          title,
          description: `${title} recursive description`,
          summaryText: `${title}. ${title} recursive description`,
          applications,
          applicationBundleIdentifiers: applications.map(
            (application) => `com.example.${application.toLowerCase()}`,
          ),
          childJobKeys: input.childSummaries.map((child) => child.logicalJobKey),
        };
      },
    };
    const service = makeComputerHistoryService({
      rootDir,
      supported: true,
      permissions: {
        inputMonitoring: "granted",
        accessibility: "granted",
        screenRecording: "granted",
      },
      keyProvider: { getOrCreateKey: async () => key },
      now: () => 100_000,
      summaryJobOptions: {
        backend,
        randomAlpha: () => randomValues.shift() ?? "zzzz",
      },
    });
    await service.setEnabled({ enabled: true, consentAt: "2026-08-19T00:00:00.000Z" });
    await service.recordObservation({
      capturedAtMs: 1_000,
      app: { bundleIdentifier: "com.example.first", name: "First" },
      window: {},
    });
    await service.recordObservation({
      capturedAtMs: 2_000,
      app: { bundleIdentifier: "com.example.second", name: "Second" },
      window: {},
    });
    await service.pause();
    await service.resume();
    const oldPath = (await service.listHistory()).entries[0]!.memoryFilePath;
    expect(oldPath).toMatch(/-oldx-10min-first-second\.md$/u);
    const blockedPath = join(rootDir, "resources", "1970-01-01T00-00-00-newx-10min-first.md");
    await mkdir(join(rootDir, "outside"));
    await symlink(
      join(rootDir, "outside"),
      blockedPath,
      process.platform === "win32" ? "junction" : "dir",
    );
    await service.clearHistory({
      scope: "last_10m",
      intervalStartMs: 2_000,
      intervalEndMs: 2_000,
    });
    const afterFailure = (await service.listHistory()).entries[0];
    expect(afterFailure?.applications.map((application) => application.displayName)).toEqual([
      "First",
    ]);
    expect(afterFailure?.memoryFilePath).toMatch(/-[a-f0-9]{16}-10min-memory-summary\.md$/u);
    expect(afterFailure?.memoryFilePath).not.toBe(oldPath);
    await expect(stat(oldPath)).resolves.toBeDefined();
    await service.setEnabled({ enabled: false });
  });

  it("stores caller access audits only as authenticated ciphertext", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-audit-"));
    const key = createTestHistoryKey();
    const service = await makePersistentService(rootDir, key);
    await service.recordAccessAudit({
      tool: "history_query",
      callerThreadId: "thread-must-not-be-plaintext",
      callerProvider: "provider-must-not-be-plaintext",
      resultCount: 1,
    });
    const files = await readdir(rootDir);
    expect(files).toContain("access-audit.moss-history");
    expect(files).not.toContain("access-audit.jsonl");
    const ciphertext = await readFile(join(rootDir, "access-audit.moss-history"), "utf8");
    expect(ciphertext).not.toContain("thread-must-not-be-plaintext");
    expect(ciphertext).not.toContain("provider-must-not-be-plaintext");
    expect((await service.getState()).health.storageBytes).toBeGreaterThan(0);
  });

  it("clears encrypted access audits only for an all-history clear", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-clear-audit-"));
    const key = createTestHistoryKey();
    const service = await makePersistentService(rootDir, key);
    await service.recordAccessAudit({
      tool: "history_query",
      callerThreadId: "clear-audit-thread",
      callerProvider: "clear-audit-provider",
      resultCount: 0,
    });
    expect((await service.getState()).health.storageBytes).toBeGreaterThan(0);
    await service.clearHistory({ scope: "all" });
    expect((await service.getState()).health.storageBytes).toBe(0);
    await expect(stat(join(rootDir, "access-audit.moss-history"))).rejects.toThrow();
  });

  it("hides records past the seven-day query cutoff without a new prune", async () => {
    let nowMs = COMPUTER_HISTORY_RETENTION_MS + 100_000;
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-retention-"));
    const key = createTestHistoryKey();
    const service = makeComputerHistoryService({
      rootDir,
      supported: true,
      permissions: {
        inputMonitoring: "granted",
        accessibility: "granted",
        screenRecording: "granted",
      },
      keyProvider: { getOrCreateKey: async () => key },
      now: () => nowMs,
    });
    await service.setEnabled({ enabled: true, consentAt: "2026-08-19T00:00:00.000Z" });
    await service.recordObservation({
      capturedAtMs: nowMs - COMPUTER_HISTORY_RETENTION_MS,
      app: { bundleIdentifier: "com.example.editor", name: "Editor" },
      window: {},
    });
    await service.recordObservation({
      capturedAtMs: nowMs,
      app: { bundleIdentifier: "com.example.editor", name: "Editor" },
      window: {},
    });
    expect((await service.listHistory()).entries).toHaveLength(2);
    nowMs += 1;
    await service.setEnabled({ enabled: false });
    expect((await service.listHistory()).entries).toHaveLength(1);
  });

  it("prunes expired engine inputs and their recursive resources at the retention boundary", async () => {
    let nowMs = COMPUTER_HISTORY_RETENTION_MS + 100_000;
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-retention-jobs-"));
    const key = createTestHistoryKey();
    const service = makeComputerHistoryService({
      rootDir,
      supported: true,
      permissions: {
        inputMonitoring: "granted",
        accessibility: "granted",
        screenRecording: "granted",
      },
      keyProvider: { getOrCreateKey: async () => key },
      now: () => nowMs,
    });
    await service.setEnabled({ enabled: true, consentAt: "2026-08-19T00:00:00.000Z" });
    await service.recordObservation({
      capturedAtMs: nowMs - COMPUTER_HISTORY_RETENTION_MS,
      app: { bundleIdentifier: "com.example.expired", name: "Expired" },
      window: {},
    });
    nowMs += 1;
    await service.recordObservation({
      capturedAtMs: nowMs,
      app: { bundleIdentifier: "com.example.current", name: "Current" },
      window: {},
    });
    const manifest = JSON.parse(
      await readFile(join(rootDir, "resources", "summary-jobs-manifest.json"), "utf8"),
    ) as { files?: Record<string, string> };
    const currentStart = Math.floor(nowMs / (10 * 60 * 1_000)) * (10 * 60 * 1_000);
    expect(Object.keys(manifest.files ?? {})).toEqual([`10min:${currentStart}`]);
    expect((await service.listHistory()).entries).toHaveLength(1);
    expect((await service.listHistory()).entries[0]?.applications[0]?.displayName).toBe("Current");
    await service.setEnabled({ enabled: false });
  });

  it("clamps queries to 200 entries and disables without deleting ciphertext", async () => {
    const service = await makeService();
    await service.setEnabled({ enabled: true, consentAt: "2026-08-19T00:00:00.000Z" });
    for (let index = 0; index < 205; index += 1) {
      await service.recordObservation({
        capturedAtMs: index * 10 * 60 * 1_000 + 1,
        app: { bundleIdentifier: "com.example.editor", name: "Editor" },
        window: {},
      });
    }
    const projected = await service.listHistory({ limit: 500 });
    expect(projected.entries.length).toBeLessThanOrEqual(200);
    const intervals = await service.listHistorySummaryIntervals({ sinceMs: 0 });
    expect(intervals.intervals.filter((interval) => interval.kind === "10min")).toHaveLength(205);
    await service.setEnabled({ enabled: false });
    expect((await service.getState()).health.storageBytes).toBeGreaterThan(0);
  });

  it("restores enabled and paused state from an atomic runtime marker", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-restart-"));
    const key = createTestHistoryKey();
    const first = await makePersistentService(rootDir, key);
    await first.setEnabled({ enabled: true, consentAt: "2026-08-19T00:00:00.000Z" });
    const runningRestart = await makePersistentService(rootDir, key);
    const runningState = await runningRestart.getState();
    expect(runningState.enabled).toBe(true);
    expect(runningState.recorderState).toBe("running");
    await first.pause();
    expect((await first.getState()).recorderState).toBe("paused");

    const restarted = await makePersistentService(rootDir, key);
    const state = await restarted.getState();
    expect(state.enabled).toBe(true);
    expect(state.recorderState).toBe("paused");
    expect(state.privateBrowsingExcluded).toBe(true);
    await restarted.resume();
    expect((await restarted.getState()).recorderState).toBe("running");
  });

  it("serializes an append submitted before a concurrent clear", async () => {
    const service = await makeService();
    await service.setEnabled({ enabled: true, consentAt: "2026-08-19T00:00:00.000Z" });
    const append = service.recordObservation({
      capturedAtMs: 20,
      app: { bundleIdentifier: "com.example.editor", name: "Editor" },
      window: {},
    });
    // Let the append enqueue its serialized store operation before issuing
    // the concurrent clear; the queue must make the ordering deterministic.
    await Promise.resolve();
    const clear = service.clearHistory({ scope: "all" });
    await Promise.all([append, clear]);
    expect((await service.listHistory()).entries).toHaveLength(0);
  });

  it("reveals the current summary file and clears only generated resources", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-reveal-"));
    const key = createTestHistoryKey();
    const revealed: string[] = [];
    const service = makeComputerHistoryService({
      rootDir,
      supported: true,
      permissions: {
        inputMonitoring: "granted",
        accessibility: "granted",
        screenRecording: "granted",
      },
      keyProvider: { getOrCreateKey: async () => key },
      now: () => 100_000,
      revealInFinder: (path) => {
        revealed.push(path);
      },
    });
    await service.setEnabled({ enabled: true, consentAt: "2026-08-19T00:00:00.000Z" });
    await service.recordObservation({
      capturedAtMs: 10_000,
      app: { bundleIdentifier: "com.example.editor", name: "Editor" },
      window: { title: "Safe title" },
    });
    const entry = (await service.listHistory()).entries[0];
    expect(entry).toBeDefined();
    if (process.platform === "darwin") {
      await expect(service.revealInFinder({ entryId: entry!.id })).resolves.toEqual({
        opened: true,
      });
      expect(revealed).toHaveLength(1);
      expect(revealed[0]).toContain("/resources/");
      expect(revealed[0]).toMatch(
        /(?:[a-z]{4}-10min-[a-z0-9-]+|[a-f0-9]{16}-10min-memory-summary)\.md$/u,
      );
      expect(revealed[0]).not.toBe(rootDir);
      expect((await stat(revealed[0]!)).mode & 0o777).toBe(0o600);
    } else {
      await expect(service.revealInFinder({ entryId: entry!.id })).resolves.toEqual({
        opened: false,
      });
      expect(revealed).toHaveLength(0);
    }
    await expect(service.revealInFinder({ entryId: "../events.moss-history" })).resolves.toEqual({
      opened: false,
    });
    await expect(service.clearHistory({ scope: "all" })).resolves.toMatchObject({
      deletedCount: 1,
      summaryIndexRefresh: "complete",
    });
    expect((await service.listHistory()).entries).toEqual([]);
    expect(
      (await readdir(join(rootDir, "resources"))).filter(
        (name) =>
          name.endsWith("memory-summary.md") ||
          name === "summary-jobs-manifest.json" ||
          /-[a-z]{4}-(?:10min|6h)-[a-z0-9-]+\.md$/u.test(name),
      ),
    ).toEqual([]);
  });

  it("lists completed six-hour parents with their ten-minute intervals and limits suggestions to 48 hours", async () => {
    const nowMs = 3 * 24 * 60 * 60 * 1_000;
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-summary-service-"));
    const key = createTestHistoryKey();
    const service = makeComputerHistoryService({
      rootDir,
      supported: true,
      permissions: {
        inputMonitoring: "granted",
        accessibility: "granted",
        screenRecording: "granted",
      },
      keyProvider: { getOrCreateKey: async () => key },
      now: () => nowMs,
    });
    await service.setEnabled({ enabled: true, consentAt: "2026-08-19T00:00:00.000Z" });
    for (const capturedAtMs of [
      nowMs - 3 * 24 * 60 * 60 * 1_000,
      nowMs - 3 * 24 * 60 * 60 * 1_000 + 10 * 60 * 1_000,
      nowMs - 3 * 24 * 60 * 60 * 1_000 + 20 * 60 * 1_000,
    ]) {
      await service.recordObservation({
        capturedAtMs,
        app: { bundleIdentifier: "com.example.stale", name: "StaleEditor" },
        window: {},
      });
    }
    await service.recordObservation({
      capturedAtMs: nowMs - 7 * 60 * 60 * 1_000,
      app: { bundleIdentifier: "com.example.older-recent", name: "OlderRecentEditor" },
      window: {},
    });
    for (const capturedAtMs of [nowMs - 60 * 60 * 1_000, nowMs - 50 * 60 * 1_000]) {
      await service.recordObservation({
        capturedAtMs,
        app: { bundleIdentifier: "com.example.recent", name: "RecentEditor" },
        window: {},
      });
    }
    const entries = (await service.listHistory()).entries;
    expect(entries.some((entry) => entry.id.includes("history-summary-6h-"))).toBe(true);
    const intervals = await service.listHistorySummaryIntervals({ sinceMs: 0 });
    expect(intervals.intervals.some((interval) => interval.kind === "6h")).toBe(true);
    expect(intervals.intervals.some((interval) => interval.kind === "10min")).toBe(true);
    const suggestions = await service.listHistorySuggestions();
    expect(suggestions.suggestions).toHaveLength(2);
    expect(suggestions.suggestions[0]).toMatchObject({
      id: expect.stringContaining("history-summary-6h-"),
      title: expect.stringContaining("Review"),
      explanation: expect.stringContaining("six-hour"),
      kind: "skill",
      prompt: expect.stringContaining("Consult the memory at "),
    });
    expect(suggestions.suggestions[0]?.prompt).toContain(
      "events.jsonl files cited there to understand the recorded workflow and my actions.",
    );
    expect(suggestions.suggestions[0]?.title).toContain("RecentEditor");
    expect(suggestions.suggestions[1]?.title).toContain("OlderRecentEditor");
    expect(new Set(suggestions.suggestions.map((suggestion) => suggestion.id)).size).toBe(2);
    await expect(service.listHistorySuggestions()).resolves.toEqual(suggestions);
    expect(
      (await service.listHistorySuggestions({ sinceMs: nowMs - 2 * 60 * 60 * 1_000 })).suggestions,
    ).toHaveLength(1);
    expect(
      (await service.listHistorySuggestions({ sinceMs: nowMs - 30 * 60 * 1_000 })).suggestions,
    ).toEqual([]);
  });

  it("includes the exact 48-hour suggestion boundary and excludes one millisecond before it", async () => {
    const nowMs = 12 * 6 * 60 * 60 * 1_000;
    const cutoffMs = nowMs - COMPUTER_HISTORY_SUGGESTION_WINDOW_MS;
    const makeBoundaryService = async (capturedAtMs: number, suffix: string) => {
      const rootDir = await mkdtemp(join(tmpdir(), `moss-history-suggestion-boundary-${suffix}-`));
      const key = createTestHistoryKey();
      const service = makeComputerHistoryService({
        rootDir,
        supported: true,
        permissions: {
          inputMonitoring: "granted",
          accessibility: "granted",
          screenRecording: "granted",
        },
        keyProvider: { getOrCreateKey: async () => key },
        now: () => nowMs,
      });
      await service.setEnabled({ enabled: true, consentAt: "2026-08-19T00:00:00.000Z" });
      await expect(
        service.recordObservation({
          capturedAtMs,
          app: { bundleIdentifier: `com.example.boundary.${suffix}`, name: "Boundary Editor" },
          window: {},
        }),
      ).resolves.toBe(true);
      return service;
    };

    const atCutoff = await makeBoundaryService(cutoffMs, "included");
    await expect(atCutoff.listHistorySuggestions()).resolves.toMatchObject({
      suggestions: [
        {
          id: expect.stringContaining("history-summary-6h-"),
          kind: "skill",
        },
      ],
    });

    const beforeCutoff = await makeBoundaryService(cutoffMs - 1, "excluded");
    await expect(beforeCutoff.listHistorySuggestions()).resolves.toEqual({ suggestions: [] });
  });

  it("enables semantic summaries only after an exact helper capability and live receipt", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-semantic-capture-"));
    const helperPath = join(rootDir, "history-helper.mjs");
    await writeFile(
      helperPath,
      `#!/usr/bin/env node
const detail = 'Apple on-device semantic summaries are available.';
const candidate = {type:'history_capture_candidate',requestId:'semantic',fingerprint:'a'.repeat(64),app:{bundleIdentifier:'com.example.editor',name:'Editor'},window:{title:'Editor'},privateBrowsing:false};
function send(value){process.stdout.write(JSON.stringify(value)+'\\n');}
send({type:'history_permissions',inputMonitoring:'unknown',accessibility:'unknown',screenRecording:'granted'});
send({type:'history_semantic_capability',status:'available',detail});
setTimeout(() => send(candidate), 40);
let buffer='';
process.stdin.on('data', chunk => { buffer += chunk; const lines=buffer.split(/\\r?\\n/); buffer=lines.pop() ?? ''; for (const line of lines) { if (!line.trim()) continue; const decision=JSON.parse(line); if (decision.requestId === 'semantic' && decision.allow) { const observation={type:'history_observation',requestId:'semantic',fingerprint:'a'.repeat(64),capturedAt:new Date().toISOString(),app:{bundleIdentifier:'com.example.editor',name:'Editor'},window:{},semanticSummary:{title:'Editing a project',description:'Reviewing high-level work in the editor',source:'apple_on_device'}}; setTimeout(() => send(observation), 5); setTimeout(() => send(observation), 15); } } });
process.stdin.resume();
setInterval(() => {}, 1000);
`,
      { mode: 0o700 },
    );
    const key = createTestHistoryKey();
    const service = makeComputerHistoryService({
      rootDir,
      supported: true,
      helperPath,
      permissions: {
        inputMonitoring: "granted",
        accessibility: "granted",
        screenRecording: "granted",
      },
      keyProvider: { getOrCreateKey: async () => key },
      now: Date.now,
    });
    await service.setEnabled({ enabled: true, consentAt: "2026-08-19T00:00:00.000Z" });
    try {
      const state = await pollUntil(
        () => service.getState(),
        (value) => value.captureCapability.activitySummaries,
      );
      expect(state.captureCapability).toMatchObject({
        mode: "interaction_activity",
        activitySummaries: true,
      });
      const history = await pollUntil(
        () => service.listHistory(),
        (value) => value.entries.length > 0,
      );
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({
        title: "Editing a project",
        description: "Reviewing high-level work in the editor",
      });
      const ciphertext = await readFile(join(rootDir, "events.moss-history"), "utf8");
      expect(ciphertext).not.toContain("Editing a project");
    } finally {
      await service.setEnabled({ enabled: false });
    }
  });

  it("rejects forged semantic summaries without a receipt and rejects unsafe output", async () => {
    const service = await makeService();
    await service.setEnabled({ enabled: true, consentAt: "2026-08-19T00:00:00.000Z" });
    const valid = {
      title: "Editing a project",
      description: "Reviewing high-level work in the editor",
      source: "apple_on_device" as const,
    };
    await expect(
      service.recordObservation({
        capturedAtMs: 1,
        app: { bundleIdentifier: "com.example.editor", name: "Editor" },
        window: {},
        semanticSummary: valid,
      }),
    ).resolves.toBe(false);
    await expect(
      service.recordObservation({
        capturedAtMs: 2,
        app: { bundleIdentifier: "com.example.editor", name: "Editor" },
        window: {},
        semanticSummary: {
          title: "Open https://example.test/private",
          description: "Activity",
          source: "apple_on_device",
        },
      } as never),
    ).resolves.toBe(false);
    await expect(
      service.recordObservation({
        capturedAtMs: 3,
        app: { bundleIdentifier: "com.example.editor", name: "Editor" },
        window: {},
        semanticSummary: {
          ...valid,
          extra: "reject",
        },
      } as never),
    ).resolves.toBe(false);
    await service.setEnabled({ enabled: false });
  });

  it("keeps semantic capability false for malformed messages and resets it on helper exit", async () => {
    const malformedRoot = await mkdtemp(join(tmpdir(), "moss-history-semantic-malformed-"));
    const malformedHelper = join(malformedRoot, "history-helper.mjs");
    await writeFile(
      malformedHelper,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({type:'history_permissions',inputMonitoring:'unknown',accessibility:'unknown',screenRecording:'granted'})+'\\n');
process.stdout.write(JSON.stringify({type:'history_semantic_capability',status:'available',detail:'Apple on-device semantic summaries are available.',extra:'reject'})+'\\n');
process.stdout.write(JSON.stringify({type:'history_semantic_capability',status:'unavailable',detail:'Apple on-device semantic summaries are unavailable.'})+'\\n');
setInterval(() => {}, 1000);
`,
      { mode: 0o700 },
    );
    const malformedService = makeComputerHistoryService({
      rootDir: malformedRoot,
      supported: true,
      helperPath: malformedHelper,
      permissions: {
        inputMonitoring: "granted",
        accessibility: "granted",
        screenRecording: "granted",
      },
      keyProvider: { getOrCreateKey: async () => createTestHistoryKey() },
    });
    await malformedService.setEnabled({ enabled: true, consentAt: "2026-08-19T00:00:00.000Z" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect((await malformedService.getState()).captureCapability.activitySummaries).toBe(false);
    } finally {
      await malformedService.setEnabled({ enabled: false });
    }

    const exitRoot = await mkdtemp(join(tmpdir(), "moss-history-semantic-exit-"));
    const exitHelper = join(exitRoot, "history-helper.mjs");
    const exitMarker = join(exitRoot, "exit-now");
    await writeFile(
      exitHelper,
      `#!/usr/bin/env node
import * as fs from 'node:fs';
process.stdout.write(JSON.stringify({type:'history_permissions',inputMonitoring:'unknown',accessibility:'unknown',screenRecording:'granted'})+'\\n');
process.stdout.write(JSON.stringify({type:'history_semantic_capability',status:'available',detail:'Apple on-device semantic summaries are available.'})+'\\n');
setInterval(() => { if (fs.existsSync(${JSON.stringify(exitMarker)})) process.exit(0); }, 20);
`,
      { mode: 0o700 },
    );
    const exitService = makeComputerHistoryService({
      rootDir: exitRoot,
      supported: true,
      helperPath: exitHelper,
      permissions: {
        inputMonitoring: "granted",
        accessibility: "granted",
        screenRecording: "granted",
      },
      keyProvider: { getOrCreateKey: async () => createTestHistoryKey() },
    });
    await exitService.setEnabled({ enabled: true, consentAt: "2026-08-19T00:00:00.000Z" });
    try {
      const activeState = await pollUntil(
        () => exitService.getState(),
        (value) => value.captureCapability.activitySummaries,
      );
      expect(activeState.captureCapability.activitySummaries).toBe(true);
      await writeFile(exitMarker, "stop\n");
      const stoppedState = await pollUntil(
        () => exitService.getState(),
        (value) => !value.captureCapability.activitySummaries,
        { intervalMs: 20 },
      );
      expect(stoppedState.captureCapability).toMatchObject({
        mode: "window_metadata_only",
        activitySummaries: false,
      });
      expect(stoppedState.recorderState).toBe("stopped");
    } finally {
      await exitService.setEnabled({ enabled: false });
    }
  });

  it("accepts semantic output only for a verified normal browser receipt", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-semantic-browser-"));
    const helperPath = join(rootDir, "history-helper.mjs");
    const decisionsPath = join(rootDir, "decisions.jsonl");
    await writeFile(decisionsPath, "");
    await writeFile(
      helperPath,
      `#!/usr/bin/env node
import * as fs from 'node:fs';
const decisions = ${JSON.stringify(decisionsPath)};
const normal = {type:'history_capture_candidate',requestId:'normal',fingerprint:'a'.repeat(64),app:{bundleIdentifier:'com.google.Chrome',name:'Google Chrome'},window:{title:'Normal',url:'https://example.test'},privateBrowsing:false,browserMode:'normal'};
const privateCandidate = {type:'history_capture_candidate',requestId:'private',fingerprint:'b'.repeat(64),app:{bundleIdentifier:'com.google.Chrome',name:'Google Chrome'},window:{title:'Private',url:'https://example.test'},privateBrowsing:true,browserMode:'incognito'};
const unsupported = {type:'history_capture_candidate',requestId:'unsupported',fingerprint:'c'.repeat(64),app:{bundleIdentifier:'com.apple.Safari',name:'Safari'},window:{title:'Safari'},privateBrowsing:false};
function send(value){process.stdout.write(JSON.stringify(value)+'\\n');}
send({type:'history_permissions',inputMonitoring:'unknown',accessibility:'unknown',screenRecording:'granted'});
send({type:'history_semantic_capability',status:'available',detail:'Apple on-device semantic summaries are available.'});
send({type:'history_browser_capabilities',browsers:[{bundleIdentifier:'com.google.Chrome',name:'Google Chrome',status:'supported',detail:'verified'}]});
setTimeout(() => send(normal), 40);
setTimeout(() => send(privateCandidate), 60);
setTimeout(() => send(unsupported), 80);
let buffer='';
process.stdin.on('data', chunk => { buffer += chunk; const lines=buffer.split(/\\r?\\n/); buffer=lines.pop() ?? ''; for (const line of lines) { if (!line.trim()) continue; const decision=JSON.parse(line); fs.appendFileSync(decisions, line+'\\n'); if (decision.requestId === 'normal' && decision.allow) setTimeout(() => send({type:'history_observation',requestId:'normal',fingerprint:'a'.repeat(64),capturedAt:new Date().toISOString(),app:{bundleIdentifier:'com.google.Chrome',name:'Google Chrome'},window:{},semanticSummary:{title:'Reviewing a page',description:'Comparing high-level research activity',source:'apple_on_device'}}), 5); } });
process.stdin.resume();
setInterval(() => {}, 1000);
`,
      { mode: 0o700 },
    );
    const key = createTestHistoryKey();
    const service = makeComputerHistoryService({
      rootDir,
      supported: true,
      helperPath,
      permissions: {
        inputMonitoring: "granted",
        accessibility: "granted",
        screenRecording: "granted",
      },
      keyProvider: { getOrCreateKey: async () => key },
      now: Date.now,
    });
    await service.setEnabled({ enabled: true, consentAt: "2026-08-19T00:00:00.000Z" });
    let entries = (await service.listHistory()).entries;
    for (let index = 0; index < 60 && entries.length === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      entries = (await service.listHistory()).entries;
    }
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      title: "Reviewing a page",
      description: "Comparing high-level research activity",
    });
    let decisionsText = "";
    for (let index = 0; index < 40; index += 1) {
      decisionsText = await readFile(decisionsPath, "utf8");
      if (
        decisionsText.includes('"requestId":"private"') &&
        decisionsText.includes('"requestId":"unsupported"')
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const decisions = decisionsText
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { requestId: string; allow: boolean });
    expect(decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requestId: "normal", allow: true }),
        expect.objectContaining({ requestId: "private", allow: false }),
        expect.objectContaining({ requestId: "unsupported", allow: false }),
      ]),
    );
    await service.setEnabled({ enabled: false });
  });

  it("uses a one-shot candidate decision receipt before persisting OCR text", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-capture-protocol-"));
    const helperPath = join(rootDir, "history-helper.mjs");
    const decisionsPath = join(rootDir, "decisions.jsonl");
    await writeFile(decisionsPath, "");
    await writeFile(
      helperPath,
      `#!/usr/bin/env node
import * as fs from 'node:fs';
const decisions = ${JSON.stringify(decisionsPath)};
const blocked = {type:'history_capture_candidate',requestId:'blocked',fingerprint:'b'.repeat(64),app:{bundleIdentifier:'com.example.editor',name:'Editor'},window:{url:'https://blocked.example/path'},privateBrowsing:false};
const allowed = {type:'history_capture_candidate',requestId:'allowed',fingerprint:'a'.repeat(64),app:{bundleIdentifier:'com.example.editor',name:'Editor'},window:{title:'Editor'},privateBrowsing:false};
let buffer='';
function send(value){process.stdout.write(JSON.stringify(value)+'\\n');}
send({type:'history_permissions',inputMonitoring:'unknown',accessibility:'unknown',screenRecording:'granted'});
setTimeout(() => send(blocked), 250);
process.stdin.on('data', chunk => { buffer += chunk; const lines=buffer.split(/\\r?\\n/); buffer=lines.pop() ?? ''; for (const line of lines) { if (!line.trim()) continue; const decision=JSON.parse(line); fs.appendFileSync(decisions, JSON.stringify(decision)+'\\n'); if (decision.requestId==='blocked') setTimeout(() => send(allowed), 20); if (decision.requestId==='allowed' && decision.allow) { setTimeout(() => send({type:'history_observation',requestId:'allowed',fingerprint:'a'.repeat(64),capturedAt:new Date().toISOString(),app:{bundleIdentifier:'com.example.editor',name:'Editor',extra:'reject'},window:{title:'Extra key'},activityText:'extra',raw:'reject'}), 5); setTimeout(() => send({type:'history_observation',requestId:'allowed',fingerprint:'a'.repeat(64),capturedAt:new Date(Date.now()-120000).toISOString(),app:{bundleIdentifier:'com.example.editor',name:'Editor'},window:{title:'Past'},activityText:'past'}), 10); setTimeout(() => send({type:'history_observation',requestId:'allowed',fingerprint:'a'.repeat(64),capturedAt:new Date(Date.now()+120000).toISOString(),app:{bundleIdentifier:'com.example.editor',name:'Editor'},window:{title:'Future'},activityText:'future'}), 15); setTimeout(() => send({type:'history_observation',requestId:'allowed',fingerprint:'wrong'.repeat(16),capturedAt:new Date().toISOString(),app:{bundleIdentifier:'com.example.editor',name:'Editor'},window:{title:'Wrong'},activityText:'wrong'}), 20); setTimeout(() => send({type:'history_observation',requestId:'allowed',fingerprint:'a'.repeat(64),capturedAt:new Date().toISOString(),app:{bundleIdentifier:'com.example.editor',name:'Forged Editor'},window:{title:'Wrong name'},activityText:'wrong name'}), 25); setTimeout(() => send({type:'history_observation',requestId:'allowed',fingerprint:'a'.repeat(64),capturedAt:new Date().toISOString(),app:{bundleIdentifier:'com.example.editor',name:'Editor'},window:{title:'/Users/moss/private/secret.md'},activityText:'API key: sk-super-secret activity'}), 40); setTimeout(() => send({type:'history_observation',requestId:'allowed',fingerprint:'a'.repeat(64),capturedAt:new Date().toISOString(),app:{bundleIdentifier:'com.example.editor',name:'Editor'},window:{title:'Duplicate'},activityText:'duplicate'}), 60); } } });
process.stdin.resume();
setInterval(() => {}, 1000);
`,
      { mode: 0o700 },
    );
    const key = createTestHistoryKey();
    const service = makeComputerHistoryService({
      rootDir,
      supported: true,
      helperPath,
      permissions: {
        inputMonitoring: "granted",
        accessibility: "granted",
        screenRecording: "granted",
      },
      keyProvider: { getOrCreateKey: async () => key },
      now: Date.now,
      summaryJobOptions: {
        setTimer: () => Symbol("capture-protocol-disabled-timer"),
        clearTimer: () => undefined,
      },
    });
    await service.updateSettings({ settings });
    await service.setEnabled({ enabled: true, consentAt: "2026-08-19T00:00:00.000Z" });
    let decisionText = "";
    for (let index = 0; index < 40; index += 1) {
      decisionText = await readFile(decisionsPath, "utf8").catch(() => "");
      if (
        decisionText.includes('"requestId":"blocked"') &&
        decisionText.includes('"requestId":"allowed"')
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const decisions = decisionText
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { requestId: string; allow: boolean });
    expect(decisions).toEqual([
      {
        type: "history_capture_decision",
        requestId: "blocked",
        fingerprint: "b".repeat(64),
        allow: false,
      },
      {
        type: "history_capture_decision",
        requestId: "allowed",
        fingerprint: "a".repeat(64),
        allow: true,
      },
    ]);
    let entries = (await service.listHistory()).entries;
    for (let index = 0; index < 40 && entries.length === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      entries = (await service.listHistory()).entries;
    }
    expect(entries).toHaveLength(1);
    expect(entries[0]?.description).toContain("[redacted activity]");
    expect(entries[0]?.description).not.toContain("sk-super-secret");
    expect(entries[0]?.title).toBe("Editor");
    expect(entries[0]?.title).not.toContain("/Users/moss");
    await service.setEnabled({ enabled: false });
  });

  it("rejects private and unsupported browser candidates before any receipt", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-browser-capture-policy-"));
    const helperPath = join(rootDir, "history-helper.mjs");
    const decisionsPath = join(rootDir, "decisions.jsonl");
    await writeFile(decisionsPath, "");
    await writeFile(
      helperPath,
      `#!/usr/bin/env node
import * as fs from 'node:fs';
const decisions = ${JSON.stringify(decisionsPath)};
let buffer='';
function send(value){process.stdout.write(JSON.stringify(value)+'\\n');}
send({type:'history_permissions',inputMonitoring:'unknown',accessibility:'unknown',screenRecording:'granted'});
setTimeout(() => send({type:'history_capture_candidate',requestId:'early',fingerprint:'e'.repeat(64),app:{bundleIdentifier:'com.google.Chrome',name:'Google Chrome'},window:{title:'Early',url:'https://example.test'},privateBrowsing:false,browserMode:'normal'}), 30);
setTimeout(() => send({type:'history_browser_capabilities',browsers:[{bundleIdentifier:'com.google.Chrome',name:'Google Chrome',status:'supported',detail:'verified'}]}), 70);
setTimeout(() => send({type:'history_capture_candidate',requestId:'safari',fingerprint:'f'.repeat(64),app:{bundleIdentifier:'com.apple.Safari',name:'Safari'},window:{title:'Safari'},privateBrowsing:false}), 250);
setTimeout(() => send({type:'history_capture_candidate',requestId:'private',fingerprint:'d'.repeat(64),app:{bundleIdentifier:'com.google.Chrome',name:'Google Chrome'},window:{title:'Private',url:'https://example.test'},privateBrowsing:true,browserMode:'incognito'}), 280);
setTimeout(() => send({type:'history_capture_candidate',requestId:'unknown',fingerprint:'1'.repeat(64),app:{bundleIdentifier:'com.example.fake-browser',name:'Fake Browser'},window:{title:'Unknown',url:'https://example.test'},privateBrowsing:false,browserMode:'normal'}), 310);
setTimeout(() => send({type:'history_capture_candidate',requestId:'late',fingerprint:'c'.repeat(64),app:{bundleIdentifier:'com.google.Chrome',name:'Google Chrome'},window:{title:'Late',url:'https://example.test'},privateBrowsing:false,browserMode:'normal'}), 360);
process.stdin.on('data', chunk => { buffer += chunk; const lines=buffer.split(/\\r?\\n/); buffer=lines.pop() ?? ''; for (const line of lines) { if (!line.trim()) continue; fs.appendFileSync(decisions, line+'\\n'); } });
process.stdin.resume();
setInterval(() => {}, 1000);
`,
      { mode: 0o700 },
    );
    const key = createTestHistoryKey();
    const service = makeComputerHistoryService({
      rootDir,
      supported: true,
      helperPath,
      permissions: {
        inputMonitoring: "granted",
        accessibility: "granted",
        screenRecording: "granted",
      },
      keyProvider: { getOrCreateKey: async () => key },
      now: Date.now,
    });
    await service.setEnabled({ enabled: true, consentAt: "2026-08-19T00:00:00.000Z" });
    let decisions = "";
    for (let index = 0; index < 40; index += 1) {
      decisions = (await readFile(decisionsPath, "utf8").catch(() => "")).trim();
      if (
        decisions.includes('"requestId":"safari"') &&
        decisions.includes('"requestId":"private"') &&
        decisions.includes('"requestId":"unknown"') &&
        decisions.includes('"requestId":"late"')
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(decisions).toContain('"requestId":"safari"');
    expect(decisions).toContain('"requestId":"private"');
    expect(decisions).toContain('"requestId":"unknown"');
    expect(decisions).toContain('"requestId":"early"');
    expect(decisions).toContain('"requestId":"late"');
    expect(decisions).toMatch(/"requestId":"early"[^\n]*"allow":false/u);
    expect(decisions).toMatch(/"requestId":"late"[^\n]*"allow":true/u);
    expect(decisions).toMatch(/"allow":false/g);
    expect((await service.listHistory()).entries).toHaveLength(0);
    await service.setEnabled({ enabled: false });
  });

  it("restarts a waiting helper on retry so refreshed screen permission can run", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-permission-retry-"));
    const helperPath = join(rootDir, "history-helper.mjs");
    const countPath = join(rootDir, "starts");
    await writeFile(
      helperPath,
      `#!/usr/bin/env node
import fs from 'node:fs';
const countPath=${JSON.stringify(countPath)};
const count=Number(fs.existsSync(countPath) ? fs.readFileSync(countPath,'utf8') : 0)+1;
fs.writeFileSync(countPath,String(count));
process.stdout.write(JSON.stringify({type:'history_permissions',inputMonitoring:'unknown',accessibility:'unknown',screenRecording:count===1?'denied':'granted'})+'\\n');
setInterval(() => {}, 1000);
`,
      { mode: 0o700 },
    );
    const service = makeComputerHistoryService({
      rootDir,
      supported: true,
      helperPath,
      permissions: {
        inputMonitoring: "unknown",
        accessibility: "unknown",
        screenRecording: "pending",
      },
      keyProvider: { getOrCreateKey: async () => createTestHistoryKey() },
      now: () => 100_000,
    });
    const first = await service.setEnabled({
      enabled: true,
      consentAt: "2026-08-19T00:00:00.000Z",
    });
    expect(first.activationState).toBe("waiting_for_permissions");
    for (let index = 0; index < 40; index += 1) {
      if ((await service.getState()).screenRecordingPermission === "denied") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await service.retryActivation();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const state = await service.getState();
    expect(state.recorderState).toBe("running");
    expect(state.screenRecordingPermission).toBe("granted");
    expect(await readFile(countPath, "utf8")).toBe("2");
    await service.setEnabled({ enabled: false });
  });
});
