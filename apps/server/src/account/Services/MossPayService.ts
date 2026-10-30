import type {
  MossPayCatalog,
  MossPayCreateOrderInput,
  MossPayGetOrderInput,
  MossPayOrder,
  MossPayQuota,
} from "@synara/contracts";
import type { Effect } from "effect";
import { ServiceMap } from "effect";

import type { MossPayError } from "../mossPayGateway";

export interface MossPayServiceShape {
  readonly getCatalog: () => Effect.Effect<MossPayCatalog, MossPayError>;
  readonly getQuota: () => Effect.Effect<MossPayQuota, MossPayError>;
  readonly createOrder: (
    input: MossPayCreateOrderInput,
  ) => Effect.Effect<MossPayOrder, MossPayError>;
  readonly getOrder: (input: MossPayGetOrderInput) => Effect.Effect<MossPayOrder, MossPayError>;
}

export class MossPayService extends ServiceMap.Service<MossPayService, MossPayServiceShape>()(
  "moss/account/Services/MossPayService",
) {}
