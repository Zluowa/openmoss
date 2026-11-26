import type {
  MossDeveloperApiKeysState,
  MossDeveloperCreateApiKeyInput,
  MossDeveloperCreateApiKeyResult,
  MossDeveloperRevokeApiKeyInput,
  MossDeveloperRevokeApiKeyResult,
} from "@moss/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { MossPayError } from "../mossPayGateway";

export interface MossDeveloperKeyServiceShape {
  readonly getState: () => Effect.Effect<MossDeveloperApiKeysState, MossPayError>;
  readonly createKey: (
    input: MossDeveloperCreateApiKeyInput,
  ) => Effect.Effect<MossDeveloperCreateApiKeyResult, MossPayError>;
  readonly revokeKey: (
    input: MossDeveloperRevokeApiKeyInput,
  ) => Effect.Effect<MossDeveloperRevokeApiKeyResult, MossPayError>;
}

export class MossDeveloperKeyService extends ServiceMap.Service<
  MossDeveloperKeyService,
  MossDeveloperKeyServiceShape
>()("moss/account/MossDeveloperKeyService") {}
