// FILE: PageAppsServiceLive.ts
// Purpose: Wires PageAppsService to the profile database and to the signed-in
// Moss account's model gateway for the `ai` capability.
// Layer: Server pages/apps

import { PageAppCapabilityError } from "@moss/shared/pageAppCapabilityPlugin";
import { Effect, Layer } from "effect";

import type { MossCloudAccountService } from "../../account/Services/MossCloudAccountService";
import type { MossEnterpriseKeyAccount } from "../../account/Services/MossEnterpriseKeyAccount";
import type { MossPhoneAccountService } from "../../account/Services/MossPhoneAccountService";
import { mossCanvasTextModels } from "../../mossCanvasText";
import { resolveMossMediaCredential } from "../../mossMediaAuthority";
import { makePageAppAiGateway, pageAppAiStubEndpoint } from "./aiGateway";
import { makePageAppExtensionDeps } from "./extensions";
import { makePageAppsServiceShape, PageAppsService } from "./PageAppsService";

export const PageAppsServiceLive = Layer.effect(
  PageAppsService,
  Effect.gen(function* () {
    const services = yield* Effect.services<
      MossEnterpriseKeyAccount | MossPhoneAccountService | MossCloudAccountService
    >();
    const resolveEndpoint = async () => {
      const stub = pageAppAiStubEndpoint(process.env);
      if (stub) return stub;
      const result = await Effect.runPromise(
        Effect.result(resolveMossMediaCredential.pipe(Effect.provideServices(services))),
      );
      if (result._tag === "Failure")
        throw new PageAppCapabilityError(
          "authentication_required",
          "Sign in to Moss to use AI on this page.",
        );
      const credential = result.success;
      const models = await mossCanvasTextModels(credential).catch(() => {
        throw new PageAppCapabilityError("unavailable", "The model list is unavailable right now.");
      });
      return {
        baseUrl: credential.gatewayBaseUrl,
        accessToken: credential.accessToken,
        models,
      };
    };
    const extensions = yield* makePageAppExtensionDeps;
    return yield* makePageAppsServiceShape({
      ai: makePageAppAiGateway({ resolveEndpoint }),
      extensions,
    });
  }),
);
