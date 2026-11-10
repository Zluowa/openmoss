/**
 * ProviderHealth - Provider readiness snapshot service.
 *
 * Owns provider health checks, cache-backed snapshots, and change streaming
 * for transport layers that need provider install/auth status.
 *
 * @module ProviderHealth
 */
import type {
  ServerProviderInstallError,
  ServerProviderInstallInput,
  ServerProviderInstallResult,
  ServerProviderInstallationInput,
  ServerProviderInstallationResult,
  ServerProviderLoginError,
  ServerProviderLoginInput,
  ServerProviderLoginResult,
  ServerProviderStatus,
  ServerProviderUpdateInput,
  ServerProviderUpdateResult,
  ServerProviderUpdateError,
} from "@moss/contracts";
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

export interface ProviderHealthShape {
  /**
   * Read the latest provider health statuses.
   */
  readonly getStatuses: Effect.Effect<ReadonlyArray<ServerProviderStatus>>;

  /**
   * Force a foreground refresh of provider health snapshots.
   */
  readonly refresh: Effect.Effect<ReadonlyArray<ServerProviderStatus>>;

  /**
   * Run the allowlisted update command for a provider and publish the
   * resulting provider snapshots.
   */
  readonly updateProvider: (
    input: ServerProviderUpdateInput,
  ) => Effect.Effect<ServerProviderUpdateResult, ServerProviderUpdateError>;

  /**
   * Install an agent CLI into the Moss-managed folder with one click, publishing
   * progress as `installState` on the provider statuses.
   */
  readonly installProvider: (
    input: ServerProviderInstallInput,
  ) => Effect.Effect<ServerProviderInstallResult, ServerProviderInstallError>;

  readonly manageProviderInstallation?: (
    input: ServerProviderInstallationInput,
  ) => Effect.Effect<ServerProviderInstallationResult, ServerProviderInstallError>;

  /** Start the official provider login flow for one configured account. */
  readonly startLogin: (
    input: ServerProviderLoginInput,
  ) => Effect.Effect<ServerProviderLoginResult, ServerProviderLoginError>;

  /** Cancel the active provider login flow for one configured account. */
  readonly cancelLogin: (
    input: ServerProviderLoginInput,
  ) => Effect.Effect<ServerProviderLoginResult, ServerProviderLoginError>;

  /**
   * Stream of provider snapshot changes for config consumers.
   */
  readonly streamChanges: Stream.Stream<ReadonlyArray<ServerProviderStatus>>;
}

export class ProviderHealth extends ServiceMap.Service<ProviderHealth, ProviderHealthShape>()(
  "moss/provider/Services/ProviderHealth",
) {}
