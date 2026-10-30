/**
 * HermesAdapter - Hermes CLI ACP implementation of the generic provider adapter contract.
 *
 * @module HermesAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface HermesAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "hermes";
}

export class HermesAdapter extends ServiceMap.Service<HermesAdapter, HermesAdapterShape>()(
  "moss/provider/Services/HermesAdapter",
) {}
