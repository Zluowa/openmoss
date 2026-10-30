/**
 * KimiAdapter - Kimi Code CLI (`kimi acp`) implementation of the generic provider adapter contract.
 *
 * @module KimiAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface KimiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "kimi";
}

export class KimiAdapter extends ServiceMap.Service<KimiAdapter, KimiAdapterShape>()(
  "moss/provider/Services/KimiAdapter",
) {}
