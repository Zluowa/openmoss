/**
 * MinimaxAdapter - MiniMax Code CLI (`mcode acp`) implementation of the generic provider adapter contract.
 *
 * @module MinimaxAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface MinimaxAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "minimax";
}

export class MinimaxAdapter extends ServiceMap.Service<MinimaxAdapter, MinimaxAdapterShape>()(
  "moss/provider/Services/MinimaxAdapter",
) {}
