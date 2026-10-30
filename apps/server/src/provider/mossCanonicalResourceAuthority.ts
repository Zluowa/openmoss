import * as nodePath from "node:path";

import type {
  MossFilesystemCapability,
  MossOwnershipStore,
  MossPrivateStage,
  MossPrivateStagePayload,
} from "@synara/contracts";

import {
  makeMossNativeFilesystemCapability,
  type MossNativeFilesystemCapabilityOptions,
} from "./mossNativeFilesystemCapability.ts";
import { makeNodeMossOwnershipStore, MossResourceImportError } from "./mossResourceImport.ts";

export interface MossCanonicalResourceAuthority {
  /** The only durable Moss ownership store for this server state directory. */
  readonly ownershipStore: MossOwnershipStore;
  /** The only canonical filesystem CAS capability for this authority. */
  readonly filesystemCapability: MossFilesystemCapability;
  /** Private server-owned state; never a workspace `.moss` path. */
  readonly stateDir: string;
}

export interface MossCanonicalResourceAuthorityOptions {
  readonly stateDir: string;
  readonly ownershipStore?: MossOwnershipStore;
  readonly filesystemCapability?: MossFilesystemCapability;
  readonly nativeCapability?: Omit<
    MossNativeFilesystemCapabilityOptions,
    "ownershipStore" | "readStage"
  >;
}

function readPrivateStage(ownershipStore: MossOwnershipStore) {
  return async (stage: MossPrivateStage): Promise<MossPrivateStagePayload> => {
    if (!ownershipStore.readPrivateStage) {
      throw new MossResourceImportError(
        "durability-unsupported",
        "The canonical ownership store cannot read private mutation stages durably.",
      );
    }
    return ownershipStore.readPrivateStage({ stage });
  };
}

/**
 * Compose the single #116 store and native capability. This function does not
 * create a workspace lock, workspace manifest, projection fallback, or a
 * second authority. Injected test doubles remain explicit and server-owned.
 */
export function makeMossCanonicalResourceAuthority(
  options: MossCanonicalResourceAuthorityOptions,
): MossCanonicalResourceAuthority {
  const rawStateDir = options.stateDir.trim();
  if (!rawStateDir) {
    throw new MossResourceImportError(
      "authorization-required",
      "A dedicated server-owned Moss authority state directory is required.",
    );
  }
  const stateDir = nodePath.resolve(rawStateDir);
  if (stateDir === nodePath.parse(stateDir).root) {
    throw new MossResourceImportError(
      "authorization-required",
      "A dedicated server-owned Moss authority state directory is required.",
    );
  }
  const ownershipStore = options.ownershipStore ?? makeNodeMossOwnershipStore(stateDir);
  const filesystemCapability =
    options.filesystemCapability ??
    makeMossNativeFilesystemCapability({
      ...options.nativeCapability,
      ownershipStore,
      readStage: readPrivateStage(ownershipStore),
    });
  return { ownershipStore, filesystemCapability, stateDir };
}
