import type {
  ProviderAddMarketplaceInput,
  ProviderAddMarketplaceResult,
  ProviderComposerCapabilities,
  ProviderCatalogArtifactLocator,
  ProviderCatalogResourceKind,
  ProviderCatalogSelectionContext,
  ProviderCatalogSelectionTicket,
  ProviderCatalogSelectionTicketClaims,
  ProviderGetComposerCapabilitiesInput,
  ProviderInstallPluginInput,
  ProviderInstallPluginResult,
  ProviderListAppsInput,
  ProviderListAppsResult,
  ProviderReadAppToolsInput,
  ProviderReadAppToolsResult,
  ProviderReadAppConnectorInput,
  ProviderReadAppConnectorResult,
  ProviderReadAppConnectorTermsInput,
  ProviderReadAppConnectorTermsResult,
  ProviderStartAppConnectionInput,
  ProviderStartAppConnectionResult,
  ProviderCompleteAppConnectionInput,
  ProviderCompleteAppConnectionResult,
  ProviderListAgentsInput,
  ProviderListAgentsResult,
  ProviderListCommandsInput,
  ProviderListCommandsResult,
  ProviderListMcpInput,
  ProviderListMcpResult,
  ProviderListModelsInput,
  ProviderListModelsResult,
  ProviderListPluginsInput,
  ProviderListPluginsResult,
  ProviderListSkillsInput,
  ProviderListSkillsResult,
  ProviderReadPluginInput,
  ProviderReadPluginResult,
  ProviderRemoveMarketplaceInput,
  ProviderRemoveMarketplaceResult,
  ProviderSetAppEnabledInput,
  ProviderSetAppEnabledResult,
  ProviderSetPluginEnabledInput,
  ProviderSetPluginEnabledResult,
  ProviderUninstallPluginInput,
  ProviderUninstallPluginResult,
  ProviderUpgradeMarketplaceInput,
  ProviderUpgradeMarketplaceResult,
} from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type {
  ProviderAdapterError,
  ProviderUnsupportedError,
  ProviderValidationError,
} from "../Errors.ts";
export type ProviderDiscoveryError =
  | ProviderValidationError
  | ProviderUnsupportedError
  | ProviderAdapterError;

export interface ProviderDiscoveryCatalogSelectionIssueInput {
  readonly kind: ProviderCatalogResourceKind;
  readonly candidateId: string;
  readonly authenticatedActorId: string;
  readonly selectionContext: ProviderCatalogSelectionContext;
  readonly artifact?: ProviderCatalogArtifactLocator | null | undefined;
}

export interface ProviderDiscoveryCatalogSelectionVerifyInput {
  readonly token: string;
  readonly kind: ProviderCatalogResourceKind;
  readonly candidateId: string;
  readonly authenticatedActorId: string;
  readonly selectionContext: ProviderCatalogSelectionContext;
  readonly artifact?: ProviderCatalogArtifactLocator | null | undefined;
  readonly consume?: boolean | undefined;
}

export interface ProviderDiscoveryCatalogSelectionBoundary {
  readonly issue: (
    input: ProviderDiscoveryCatalogSelectionIssueInput,
  ) => Effect.Effect<ProviderCatalogSelectionTicket, ProviderDiscoveryError>;
  readonly verify: (
    input: ProviderDiscoveryCatalogSelectionVerifyInput,
  ) => Effect.Effect<ProviderCatalogSelectionTicketClaims, ProviderDiscoveryError>;
}

export interface ProviderDiscoveryServiceShape {
  /**
   * Server-owned metadata attestation seam. It is optional for legacy test
   * doubles, but the live discovery layer always supplies both operations.
   * This boundary never downloads, installs, or executes catalog content.
   */
  readonly catalogSelection?: ProviderDiscoveryCatalogSelectionBoundary;
  readonly getComposerCapabilities: (
    input: ProviderGetComposerCapabilitiesInput,
  ) => Effect.Effect<ProviderComposerCapabilities, ProviderDiscoveryError>;
  readonly listCommands: (
    input: ProviderListCommandsInput,
  ) => Effect.Effect<ProviderListCommandsResult, ProviderDiscoveryError>;
  readonly listSkills: (
    input: ProviderListSkillsInput,
  ) => Effect.Effect<ProviderListSkillsResult, ProviderDiscoveryError>;
  readonly listPlugins: (
    input: ProviderListPluginsInput,
  ) => Effect.Effect<ProviderListPluginsResult, ProviderDiscoveryError>;
  readonly readPlugin: (
    input: ProviderReadPluginInput,
  ) => Effect.Effect<ProviderReadPluginResult, ProviderDiscoveryError>;
  readonly addMarketplace: (
    input: ProviderAddMarketplaceInput,
  ) => Effect.Effect<ProviderAddMarketplaceResult, ProviderDiscoveryError>;
  readonly removeMarketplace: (
    input: ProviderRemoveMarketplaceInput,
  ) => Effect.Effect<ProviderRemoveMarketplaceResult, ProviderDiscoveryError>;
  readonly upgradeMarketplace: (
    input: ProviderUpgradeMarketplaceInput,
  ) => Effect.Effect<ProviderUpgradeMarketplaceResult, ProviderDiscoveryError>;
  readonly installPlugin: (
    input: ProviderInstallPluginInput,
  ) => Effect.Effect<ProviderInstallPluginResult, ProviderDiscoveryError>;
  readonly uninstallPlugin: (
    input: ProviderUninstallPluginInput,
  ) => Effect.Effect<ProviderUninstallPluginResult, ProviderDiscoveryError>;
  readonly setPluginEnabled: (
    input: ProviderSetPluginEnabledInput,
  ) => Effect.Effect<ProviderSetPluginEnabledResult, ProviderDiscoveryError>;
  readonly listApps: (
    input: ProviderListAppsInput,
  ) => Effect.Effect<ProviderListAppsResult, ProviderDiscoveryError>;
  readonly setAppEnabled: (
    input: ProviderSetAppEnabledInput,
  ) => Effect.Effect<ProviderSetAppEnabledResult, ProviderDiscoveryError>;
  readonly readAppTools: (
    input: ProviderReadAppToolsInput,
  ) => Effect.Effect<ProviderReadAppToolsResult, ProviderDiscoveryError>;
  readonly readAppConnector: (
    input: ProviderReadAppConnectorInput,
  ) => Effect.Effect<ProviderReadAppConnectorResult, ProviderDiscoveryError>;
  readonly readAppConnectorTerms: (
    input: ProviderReadAppConnectorTermsInput,
  ) => Effect.Effect<ProviderReadAppConnectorTermsResult, ProviderDiscoveryError>;
  readonly startAppConnection: (
    input: ProviderStartAppConnectionInput,
  ) => Effect.Effect<ProviderStartAppConnectionResult, ProviderDiscoveryError>;
  readonly completeAppConnection: (
    input: ProviderCompleteAppConnectionInput,
  ) => Effect.Effect<ProviderCompleteAppConnectionResult, ProviderDiscoveryError>;
  readonly listModels: (
    input: ProviderListModelsInput,
  ) => Effect.Effect<ProviderListModelsResult, ProviderDiscoveryError>;
  readonly listAgents: (
    input: ProviderListAgentsInput,
  ) => Effect.Effect<ProviderListAgentsResult, ProviderDiscoveryError>;
  readonly listMcp: (
    input: ProviderListMcpInput,
  ) => Effect.Effect<ProviderListMcpResult, ProviderDiscoveryError>;
}

export class ProviderDiscoveryService extends ServiceMap.Service<
  ProviderDiscoveryService,
  ProviderDiscoveryServiceShape
>()("moss/provider/Services/ProviderDiscoveryService") {}
