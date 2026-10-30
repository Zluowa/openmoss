// Purpose: Test-only Moss server entry for the inline-visualization browser harness.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";

import { mossServerProgram } from "../apps/server/src/index.ts";
import { inlineVisualizationVerificationAccountLayer } from "./inlineVisualizationVerificationLayer.ts";

NodeRuntime.runMain(
  mossServerProgram({
    additionalRuntimeServicesLayer: inlineVisualizationVerificationAccountLayer,
  }),
);
