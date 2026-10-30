import * as Path from "node:path";

const CANONICAL_FILESYSTEM_HELPER_NAME = "moss-canonical-filesystem-helper";

export const MOSS_CANONICAL_FILESYSTEM_HELPER_PATH_ENV = "MOSS_CANONICAL_FILESYSTEM_HELPER_PATH";
export const MOSS_CANONICAL_FILESYSTEM_HELPER_METADATA_PATH_ENV =
  "MOSS_CANONICAL_FILESYSTEM_HELPER_METADATA_PATH";

interface CanonicalFilesystemHelperRuntimePathInput {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly desktopMainDirname: string;
}

interface CanonicalFilesystemHelperRuntimePaths {
  readonly helperPath: string;
  readonly metadataPath: string;
}

interface CanonicalFilesystemHelperBackendEnvInput extends CanonicalFilesystemHelperRuntimePathInput {
  readonly inheritedEnv: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
}

export function resolveCanonicalFilesystemHelperRuntimePaths(
  input: CanonicalFilesystemHelperRuntimePathInput,
): CanonicalFilesystemHelperRuntimePaths {
  const helperPath = input.isPackaged
    ? Path.resolve(input.resourcesPath, "..", "Helpers", CANONICAL_FILESYSTEM_HELPER_NAME)
    : Path.resolve(
        input.desktopMainDirname,
        "..",
        "..",
        "server",
        "native",
        CANONICAL_FILESYSTEM_HELPER_NAME,
        "build",
        CANONICAL_FILESYSTEM_HELPER_NAME,
      );
  const metadataPath = input.isPackaged
    ? Path.join(input.resourcesPath, `${CANONICAL_FILESYSTEM_HELPER_NAME}.build.json`)
    : `${helperPath}.build.json`;

  return { helperPath, metadataPath };
}

export function canonicalFilesystemHelperBackendEnv(
  input: CanonicalFilesystemHelperBackendEnvInput,
): NodeJS.ProcessEnv {
  const env = { ...input.inheritedEnv };
  delete env[MOSS_CANONICAL_FILESYSTEM_HELPER_PATH_ENV];
  delete env[MOSS_CANONICAL_FILESYSTEM_HELPER_METADATA_PATH_ENV];

  if (input.platform !== "darwin") return env;

  const paths = resolveCanonicalFilesystemHelperRuntimePaths(input);
  env[MOSS_CANONICAL_FILESYSTEM_HELPER_PATH_ENV] = paths.helperPath;
  env[MOSS_CANONICAL_FILESYSTEM_HELPER_METADATA_PATH_ENV] = paths.metadataPath;
  return env;
}
