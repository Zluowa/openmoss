import { SUPPORTED_PROVIDER_KINDS, type ProviderInstanceConfigMap } from "@synara/contracts";

/** Registered instances for tests that supply fake adapters for each built-in driver. */
export const TEST_PROVIDER_INSTANCES: ProviderInstanceConfigMap = Object.fromEntries(
  SUPPORTED_PROVIDER_KINDS.map((driver) => [driver, { driver, enabled: true }]),
);
