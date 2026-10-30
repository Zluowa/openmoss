// FILE: bootstrap.ts
// Purpose: Completes synchronous renderer storage migration before any app store can hydrate.

import "./storageOriginMigration";

import { bootstrapSignedOutScreen } from "./authSignedOut";
import { prepareBootstrapLocalization } from "./bootstrapLocalization";
import { bootstrapPairingSession } from "./pairingBootstrap";

prepareBootstrapLocalization();

if (!bootstrapSignedOutScreen()) {
  void bootstrapPairingSession().then((result) => {
    if (result === "not-pairing") {
      return import("./main");
    }
  });
}
