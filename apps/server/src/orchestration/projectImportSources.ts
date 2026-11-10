// FILE: projectImportSources.ts
// Purpose: Resolve every agent store project import scans: each enabled Codex/Claude
//          account (provider instance), using the same account environment the runtime
//          launches that account with, plus the default local store of every other agent
//          Moss can read history from.
// Layer: Server orchestration (project import)

import { homedir } from "node:os";
import nodePath from "node:path";

import {
  PROJECT_IMPORT_NATIVE_PROVIDERS,
  type ProjectImportNativeProvider,
  type ProjectImportProvider,
  type ProjectImportTranscriptProvider,
  type ProviderInstanceId,
  type ProviderStartOptions,
  type ServerSettings,
} from "@moss/contracts";
import {
  deriveProviderInstances,
  providerStartOptionsFromInstance,
  type ResolvedProviderInstance,
} from "@moss/shared/providerInstances";

import { claudeHistoricalSessionEnvironment } from "./importThreadRoute";
import { canonicalImportPath } from "./projectImportPaths";
import { resolveCodexProjectImportHome } from "../provider/codexProjectImport";
import { LOCAL_HISTORY_READERS } from "../provider/localHistory";

export function isProjectImportNativeProvider(
  provider: ProjectImportProvider,
): provider is ProjectImportNativeProvider {
  return (PROJECT_IMPORT_NATIVE_PROVIDERS as ReadonlyArray<string>).includes(provider);
}

export interface ProjectImportSource {
  readonly provider: ProjectImportProvider;
  readonly instanceId: ProviderInstanceId;
  readonly isDefault: boolean;
  /** Display name of a non-default account. */
  readonly accountLabel?: string;
  /** Settings-derived launch options for this account. */
  readonly providerOptions: ProviderStartOptions | undefined;
  /** Codex account home override; history lives in this (base) home. */
  readonly codexHomePath?: string;
  /** Environment the account's runtime is launched with; agents read store overrides from it. */
  readonly environment: NodeJS.ProcessEnv;
  /** Home directory the agent's default store lives under. */
  readonly homeDir: string;
  /**
   * Claude accounts whose config dir differs from the server process's own must
   * be read through a child process: the SDK only reads process.env.
   */
  readonly claudeEnvironment?: NodeJS.ProcessEnv;
  readonly claudeConfigDir?: string;
}

function ambientClaudeConfigDir(): string {
  return nodePath.resolve(
    process.env.CLAUDE_CONFIG_DIR?.trim() || nodePath.join(homedir(), ".claude"),
  );
}

/**
 * Default accounts first, so a store shared by several accounts is attributed to
 * the default. A disabled Codex/Claude default stays listed (import refuses it with
 * a clear error); disabled non-default accounts are not scanned. Agents copied as
 * messages are read from their default store whether or not they are turned on:
 * copying history never starts them.
 */
export function resolveProjectImportSources(
  settings: ServerSettings,
  providers: ReadonlyArray<ProjectImportProvider>,
  paths: { readonly homeDir?: string | undefined; readonly stateDir?: string | undefined } = {},
): ReadonlyArray<ProjectImportSource> {
  const requested = new Set<string>(providers);
  const instances = deriveProviderInstances(settings)
    .filter(
      (instance): instance is typeof instance & { driver: ProjectImportProvider } =>
        requested.has(instance.driver) &&
        (isProjectImportNativeProvider(instance.driver as ProjectImportProvider)
          ? instance.enabled || instance.isDefault
          : instance.isDefault),
    )
    .toSorted(
      (left, right) =>
        providers.indexOf(left.driver) - providers.indexOf(right.driver) ||
        Number(right.isDefault) - Number(left.isDefault),
    );
  return instances.map(projectImportSourceFor(paths));
}

function projectImportSourceFor(paths: {
  readonly homeDir?: string | undefined;
  readonly stateDir?: string | undefined;
}) {
  return (
    instance: ResolvedProviderInstance & { readonly driver: ProjectImportProvider },
  ): ProjectImportSource => {
    const providerOptions = providerStartOptionsFromInstance(instance);
    const base = {
      instanceId: instance.instanceId,
      isDefault: instance.isDefault,
      ...(instance.isDefault ? {} : { accountLabel: instance.displayName }),
      providerOptions,
      homeDir: paths.homeDir ?? homedir(),
    };
    if (!isProjectImportNativeProvider(instance.driver)) {
      return { ...base, provider: instance.driver, environment: process.env };
    }
    if (instance.driver === "codex") {
      const codex = providerOptions?.codex;
      const source: ProjectImportSource = {
        ...base,
        provider: "codex",
        environment: { ...process.env, ...codex?.environment },
      };
      return codex?.homePath ? { ...source, codexHomePath: codex.homePath } : source;
    }
    const claudeEnvironment = claudeHistoricalSessionEnvironment(providerOptions, {
      ...(paths.homeDir ? { homeDir: paths.homeDir } : {}),
      ...(paths.stateDir ? { isolationRootDir: paths.stateDir } : {}),
      ...(instance.isDefault ? {} : { providerInstanceId: instance.instanceId }),
    });
    const environment = claudeEnvironment ?? process.env;
    const configDir = nodePath.resolve(
      environment.CLAUDE_CONFIG_DIR?.trim() ||
        nodePath.join(environment.HOME?.trim() || homedir(), ".claude"),
    );
    const source: ProjectImportSource = {
      ...base,
      provider: "claudeAgent",
      environment,
      claudeConfigDir: configDir,
    };
    return configDir === ambientClaudeConfigDir() || !claudeEnvironment
      ? source
      : { ...source, claudeEnvironment };
  };
}

/** The storage identity a source was discovered from; import revalidates it. */
export function resolveProjectImportSourceHome(source: ProjectImportSource): Promise<string> {
  if (source.provider === "codex") {
    return resolveCodexProjectImportHome({
      env: source.environment,
      ...(source.codexHomePath ? { homePath: source.codexHomePath } : {}),
    });
  }
  if (source.provider === "claudeAgent") {
    return canonicalImportPath(source.claudeConfigDir ?? ambientClaudeConfigDir());
  }
  return canonicalImportPath(
    LOCAL_HISTORY_READERS[source.provider].sourceHome(localHistoryInput(source)),
  );
}

export function localHistoryInput(source: ProjectImportSource) {
  return { homeDir: source.homeDir, env: source.environment };
}

export type ProjectImportTranscriptSource = ProjectImportSource & {
  readonly provider: ProjectImportTranscriptProvider;
};
