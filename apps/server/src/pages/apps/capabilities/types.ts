// FILE: types.ts
// Purpose: Server half of the 应用页 capability plugin interface (see
// `@moss/shared/pageAppCapabilityPlugin` for the frame and shell halves).
// Register a new capability with one line in `./index.ts`.
// Layer: Server pages/apps

import type {
  PageApp,
  PageAppCapabilities,
  PageAppStoredConsent,
  PageAppViewer,
} from "@moss/contracts";
import type { PageAppCapabilityError } from "@moss/shared/pageAppCapabilityPlugin";
import type { Effect, Stream } from "effect";

export interface PageAppServerCallContext {
  readonly app: PageApp;
  /** Revision the frame was opened on; its declared capabilities apply. */
  readonly revision: number;
  readonly capabilities: PageAppCapabilities;
  /** `capabilities[name]` for the capability being called. */
  readonly config: unknown;
  readonly viewer: PageAppViewer;
  readonly consent: Readonly<Record<string, PageAppStoredConsent>>;
}

export interface PageAppServerCapability<R = never> {
  readonly name: string;
  /**
   * "standing" capabilities need a stored "granted" before the server serves
   * them; "none" need only the declaration. Agent tools bypass consent (they
   * act for the owner through their own tool approval).
   */
  readonly consent: "none" | "standing";
  /** Validate this capability's declared config at publish time. */
  readonly validateConfig?: (config: unknown) => string | null;
  readonly call?: (
    ctx: PageAppServerCallContext,
    method: string,
    args: unknown,
  ) => Effect.Effect<unknown, PageAppCapabilityError, R>;
  readonly watch?: (
    ctx: PageAppServerCallContext,
    method: string,
    args: unknown,
  ) => Stream.Stream<unknown, PageAppCapabilityError, R>;
}
