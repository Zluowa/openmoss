// FILE: PageAppsServiceLive.ts
// Purpose: Wires PageAppsService to the profile database, the signed-in Moss
// account's model & media gateways (`ai`, `chat`, `media`), and Mossbot rooms.
// Layer: Server pages/apps

import type { ProjectId } from "@moss/contracts";
import { PageAppCapabilityError } from "@moss/shared/pageAppCapabilityPlugin";
import { Effect, Layer, Option } from "effect";

import type { MossCloudAccountService } from "../../account/Services/MossCloudAccountService";
import type { MossEnterpriseKeyAccount } from "../../account/Services/MossEnterpriseKeyAccount";
import type { MossPhoneAccountService } from "../../account/Services/MossPhoneAccountService";
import { ServerConfig } from "../../config";
import { mossCanvasTextModels } from "../../mossCanvasText";
import { resolveMossMediaCredential } from "../../mossMediaAuthority";
import { MossMediaJobsService } from "../../mossMediaJobsService";
import { MossbotRooms } from "../../mossbotRooms/service";
import { ProjectAgentService } from "../../projectAgent/Services/ProjectAgentService";
import { RealtimeVoiceService } from "../../realtimeVoice/Services/RealtimeVoiceService";
import { makePageAppAiGateway, pageAppAiStubEndpoint } from "./aiGateway";
import { makeMossMediaGateway } from "./capabilities/media";
import { makeMossbotCapabilityGateway } from "./capabilities/mossbot";
import { makePageAppVoiceGateway } from "./capabilities/voice";
import { makePageAppExtensionDeps } from "./extensions";
import { makePageAppsServiceShape, PageAppsService } from "./PageAppsService";

export const PageAppsServiceLive = Layer.effect(
  PageAppsService,
  Effect.gen(function* () {
    const services = yield* Effect.services<
      MossEnterpriseKeyAccount | MossPhoneAccountService | MossCloudAccountService
    >();
    const config = yield* ServerConfig;
    const mossbotRooms = Option.getOrNull(yield* Effect.serviceOption(MossbotRooms));
    const projectAgent = Option.getOrNull(yield* Effect.serviceOption(ProjectAgentService));
    const realtimeVoice = Option.getOrNull(yield* Effect.serviceOption(RealtimeVoiceService));

    const resolveCredential = async () => {
      const result = await Effect.runPromise(
        Effect.result(resolveMossMediaCredential.pipe(Effect.provideServices(services))),
      );
      if (result._tag === "Failure") {
        throw new PageAppCapabilityError(
          "authentication_required",
          "请先登录 Moss 账号后再在应用页使用该能力。",
        );
      }
      return result.success;
    };

    const resolveEndpoint = async () => {
      const stub = pageAppAiStubEndpoint(process.env);
      if (stub) return stub;
      const credential = await resolveCredential();
      const models = await mossCanvasTextModels(credential).catch(() => {
        throw new PageAppCapabilityError("unavailable", "模型列表暂时不可用。");
      });
      return {
        baseUrl: credential.gatewayBaseUrl,
        accessToken: credential.accessToken,
        models,
      };
    };

    const ai = makePageAppAiGateway({ resolveEndpoint });
    const extensions = yield* makePageAppExtensionDeps;
    const media = makeMossMediaGateway({
      service: new MossMediaJobsService({ stateDirectory: config.stateDir }),
      resolveCredential,
      store: extensions.store,
    });
    const mossbot = makeMossbotCapabilityGateway({
      ai,
      ...(projectAgent
        ? {
            listActiveBots: async () => {
              const summary = await Effect.runPromise(
                projectAgent.listSummaries({ includeArchived: false }, { kind: "user" }),
              );
              return summary.summaries
                .filter((g) => g.agentKind === "mossbot" && !g.pausedAt && !g.archivedAt)
                .map((g) => ({
                  id: g.projectId,
                  name: g.coordinatorName ?? "Mossbot",
                  icon: g.coordinatorIcon ?? null,
                  color: g.coordinatorColor ?? null,
                }));
            },
          }
        : {}),
      ...(mossbotRooms
        ? {
            ensureRoom: async ({ requestId, name, botIds }) => {
              const room = await mossbotRooms.create({
                requestId,
                name,
                memberProjectIds: botIds as ProjectId[],
                responder: "everyone",
              });
              return { roomId: room.id };
            },
            postToRoom: async ({ roomId, text }) => {
              await mossbotRooms.send({
                roomId,
                requestId: `pa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
                text,
              });
            },
          }
        : {}),
    });

    const voice = makePageAppVoiceGateway({
      resolveCredential,
      realtimeService: realtimeVoice,
    });

    return yield* makePageAppsServiceShape({
      ai,
      extensions,
      media,
      mossbot,
      voice,
    });
  }),
);
