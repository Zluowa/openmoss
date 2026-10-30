import * as NodeServices from "@effect/platform-node/NodeServices";
import { spawnSync } from "node:child_process";
import type { ProviderKind, ServerProviderStatus } from "@synara/contracts";
import { isProviderKind } from "@synara/shared/providerInstances";
import { Effect, Layer } from "effect";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_EVIDENCE_DIR = ".moss/ledger/evidence";
const RUNTIME_BOUNDARY = "ProviderHealthLive";
const REQUIRED_PROVIDER: ProviderKind = "codex";

export interface MossProductionProviderReadinessProvider {
  readonly provider: ProviderKind;
  readonly source: typeof RUNTIME_BOUNDARY;
  readonly status: ServerProviderStatus["status"];
  readonly available: boolean;
  readonly authStatus: ServerProviderStatus["authStatus"];
  readonly usable: boolean;
  readonly checkedAt: string;
  readonly version?: string | null | undefined;
  readonly authType?: string | undefined;
  readonly authLabel?: string | undefined;
  readonly message?: string | undefined;
  readonly versionAdvisoryStatus?: "unknown" | "current" | "behind_latest" | undefined;
  readonly updateAvailable?: boolean | undefined;
  readonly blockingReason?: string | undefined;
}

export interface MossProductionProviderReadinessReport {
  readonly version: 1;
  readonly createdAt: string;
  readonly cwd: string;
  readonly runtimeBoundary: typeof RUNTIME_BOUNDARY;
  readonly productionProviderEvidence: true;
  readonly fixtureBacked: false;
  readonly providerCredentialsRequired: true;
  readonly writesGlobalConfig: false;
  readonly writesGlobalConfigPaths: readonly [];
  readonly runtimeStateScope: "temporary";
  readonly requiredProvider: ProviderKind;
  readonly providers: ReadonlyArray<MossProductionProviderReadinessProvider>;
  readonly acceptedProviders: ReadonlyArray<ProviderKind>;
  readonly blockedProviders: ReadonlyArray<ProviderKind>;
  readonly acceptance: {
    readonly status: "pass" | "blocked-with-evidence";
    readonly requiredProviderUsable: boolean;
    readonly summary: string;
    readonly blockerSummary?: string | undefined;
  };
  readonly fullCodexParityClaim: false;
}

export interface MossProductionProviderReadinessOptions {
  readonly createdAt?: string | undefined;
  readonly cwd?: string | undefined;
  readonly output?: string | undefined;
}

function artifactDate(createdAt: string): string {
  return createdAt.slice(0, 10);
}

function defaultReportPath(createdAt: string): string {
  return `${DEFAULT_EVIDENCE_DIR}/moss-production-provider-readiness-${artifactDate(createdAt)}.json`;
}

function providerIsUsable(status: ServerProviderStatus): boolean {
  return status.available && status.authStatus !== "unauthenticated";
}

function providerBlockingReason(status: ServerProviderStatus): string | undefined {
  if (providerIsUsable(status)) {
    return undefined;
  }
  if (status.authStatus === "unauthenticated") {
    return status.message ?? `${status.provider} is not authenticated.`;
  }
  if (!status.available) {
    return status.message ?? `${status.provider} is not available.`;
  }
  return status.message ?? `${status.provider} is not usable.`;
}

function isKnownProviderStatus(
  status: ServerProviderStatus,
): status is ServerProviderStatus & { readonly provider: ProviderKind } {
  return isProviderKind(status.provider);
}

function normalizeProviderStatus(
  status: ServerProviderStatus & { readonly provider: ProviderKind },
): MossProductionProviderReadinessProvider {
  const usable = providerIsUsable(status);
  return {
    provider: status.provider,
    source: RUNTIME_BOUNDARY,
    status: status.status,
    available: status.available,
    authStatus: status.authStatus,
    usable,
    checkedAt: status.checkedAt,
    ...(status.version !== undefined ? { version: status.version } : {}),
    ...(status.authType ? { authType: status.authType } : {}),
    ...(status.authLabel ? { authLabel: status.authLabel } : {}),
    ...(status.message ? { message: status.message } : {}),
    ...(status.versionAdvisory?.status
      ? { versionAdvisoryStatus: status.versionAdvisory.status }
      : {}),
    ...(status.versionAdvisory?.status === "behind_latest" ? { updateAvailable: true } : {}),
    ...(usable ? {} : { blockingReason: providerBlockingReason(status) }),
  };
}

async function loadProviderHealthRuntime() {
  const importRuntimeModule = (specifier: string): Promise<any> => import(specifier);
  const [configModule, settingsModule, providerHealthModule, providerHealthLiveModule] =
    await Promise.all([
      importRuntimeModule(new URL("../apps/server/src/config.ts", import.meta.url).href),
      importRuntimeModule(new URL("../apps/server/src/serverSettings.ts", import.meta.url).href),
      importRuntimeModule(
        new URL("../apps/server/src/provider/Services/ProviderHealth.ts", import.meta.url).href,
      ),
      importRuntimeModule(
        new URL("../apps/server/src/provider/Layers/ProviderHealth.ts", import.meta.url).href,
      ),
    ]);

  return {
    ServerConfig: configModule.ServerConfig,
    ServerSettingsService: settingsModule.ServerSettingsService,
    ProviderHealth: providerHealthModule.ProviderHealth,
    ProviderHealthLive: providerHealthLiveModule.ProviderHealthLive,
  } as const;
}

async function refreshProductionProviderStatuses(
  cwd: string,
): Promise<ReadonlyArray<ServerProviderStatus>> {
  const { ServerConfig, ServerSettingsService, ProviderHealth, ProviderHealthLive } =
    await loadProviderHealthRuntime();
  const baseDir = mkdtempSync(join(tmpdir(), "moss-production-provider-readiness-"));
  try {
    const layer = ProviderHealthLive.pipe(
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(ServerConfig.layerTest(cwd, baseDir)),
      Layer.provideMerge(NodeServices.layer),
    );
    const program = Effect.gen(function* () {
      const providerHealth = yield* ProviderHealth;
      return yield* providerHealth.refresh;
    }).pipe(Effect.provide(layer), Effect.scoped) as Effect.Effect<
      ReadonlyArray<ServerProviderStatus>,
      unknown,
      never
    >;
    return await Effect.runPromise(program);
  } finally {
    rmSync(baseDir, { force: true, recursive: true });
  }
}

export async function buildMossProductionProviderReadinessReport(
  options: MossProductionProviderReadinessOptions = {},
): Promise<MossProductionProviderReadinessReport> {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const cwd = resolve(options.cwd ?? process.cwd());
  const statuses = await refreshProductionProviderStatuses(cwd);
  const providers = statuses.filter(isKnownProviderStatus).map(normalizeProviderStatus);
  const acceptedProviders = providers
    .filter((provider) => provider.usable)
    .map((provider) => provider.provider);
  const blockedProviders = providers
    .filter((provider) => !provider.usable)
    .map((provider) => provider.provider);
  const requiredProviderStatus = providers.find(
    (provider) => provider.provider === REQUIRED_PROVIDER,
  );
  const requiredProviderUsable = requiredProviderStatus?.usable === true;
  const acceptanceStatus =
    requiredProviderUsable || acceptedProviders.length > 0 ? "pass" : "blocked-with-evidence";
  const blockerSummary =
    acceptanceStatus === "blocked-with-evidence"
      ? `No usable production provider was confirmed. ${blockedProviders.join(", ")} blocked.`
      : requiredProviderStatus && !requiredProviderUsable
        ? `${REQUIRED_PROVIDER} is blocked: ${
            requiredProviderStatus.blockingReason ?? "no blocking reason recorded"
          }`
        : undefined;

  return {
    version: 1,
    createdAt,
    cwd,
    runtimeBoundary: RUNTIME_BOUNDARY,
    productionProviderEvidence: true,
    fixtureBacked: false,
    providerCredentialsRequired: true,
    writesGlobalConfig: false,
    writesGlobalConfigPaths: [],
    runtimeStateScope: "temporary",
    requiredProvider: REQUIRED_PROVIDER,
    providers,
    acceptedProviders,
    blockedProviders,
    acceptance: {
      status: acceptanceStatus,
      requiredProviderUsable,
      summary:
        acceptanceStatus === "pass"
          ? `Production provider readiness captured with ${acceptedProviders.length} usable provider(s).`
          : "Production provider readiness is blocked, with explicit provider evidence recorded.",
      ...(blockerSummary ? { blockerSummary } : {}),
    },
    fullCodexParityClaim: false,
  };
}

export function writeMossProductionProviderReadinessReport(input: {
  readonly report: MossProductionProviderReadinessReport;
  readonly output?: string | undefined;
  readonly cwd?: string | undefined;
}): string {
  const cwd = input.cwd ?? process.cwd();
  const output = input.output ?? defaultReportPath(input.report.createdAt);
  const absoluteOutput = resolve(cwd, output);
  mkdirSync(dirname(absoluteOutput), { recursive: true });
  writeFileSync(absoluteOutput, `${JSON.stringify(input.report, null, 2)}\n`, "utf8");
  const oxfmtPath = resolve(cwd, "node_modules/.bin/oxfmt");
  if (existsSync(oxfmtPath)) {
    spawnSync(oxfmtPath, ["--write", absoluteOutput], { cwd, stdio: "ignore" });
  }
  return output;
}

function parseCliArgs(argv: ReadonlyArray<string>): MossProductionProviderReadinessOptions {
  let createdAt: string | undefined;
  let output: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--created-at") {
      createdAt = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--output") {
      output = argv[index + 1];
      index += 1;
      continue;
    }
  }

  return {
    ...(createdAt ? { createdAt } : {}),
    ...(output ? { output } : {}),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const options = parseCliArgs(process.argv.slice(2));
  const report = await buildMossProductionProviderReadinessReport(options);
  const reportPath = writeMossProductionProviderReadinessReport({
    report,
    output: options.output,
  });
  console.log(
    JSON.stringify(
      {
        reportPath,
        acceptance: report.acceptance,
        acceptedProviders: report.acceptedProviders,
        blockedProviders: report.blockedProviders,
      },
      null,
      2,
    ),
  );
}
