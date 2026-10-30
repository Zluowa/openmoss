/**
 * ZcodeAdapter - ZCode via the zcode-acp-server bridge implementation of the generic provider adapter contract.
 *
 * @module ZcodeAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface ZcodeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "zcode";
}

export class ZcodeAdapter extends ServiceMap.Service<ZcodeAdapter, ZcodeAdapterShape>()(
  "moss/provider/Services/ZcodeAdapter",
) {}
