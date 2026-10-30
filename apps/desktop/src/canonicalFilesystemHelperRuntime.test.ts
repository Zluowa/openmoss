import { readFileSync } from "node:fs";
import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import {
  MOSS_CANONICAL_FILESYSTEM_HELPER_METADATA_PATH_ENV,
  MOSS_CANONICAL_FILESYSTEM_HELPER_PATH_ENV,
  canonicalFilesystemHelperBackendEnv,
  resolveCanonicalFilesystemHelperRuntimePaths,
} from "./canonicalFilesystemHelperRuntime";

describe("canonical filesystem helper desktop runtime", () => {
  it("resolves the packaged helper and its separate Resources metadata", () => {
    const resourcesPath = Path.resolve("/Applications/Moss.app/Contents/Resources");

    expect(
      resolveCanonicalFilesystemHelperRuntimePaths({
        isPackaged: true,
        resourcesPath,
        desktopMainDirname: "/unused",
      }),
    ).toEqual({
      helperPath: Path.resolve(resourcesPath, "..", "Helpers", "moss-canonical-filesystem-helper"),
      metadataPath: Path.join(resourcesPath, "moss-canonical-filesystem-helper.build.json"),
    });
  });

  it("keeps development metadata adjacent to the helper", () => {
    const paths = resolveCanonicalFilesystemHelperRuntimePaths({
      isPackaged: false,
      resourcesPath: "/unused",
      desktopMainDirname: Path.resolve("/repo/apps/desktop/dist-electron"),
    });

    expect(paths.helperPath).toBe(
      Path.resolve(
        "/repo/apps/server/native/moss-canonical-filesystem-helper/build/moss-canonical-filesystem-helper",
      ),
    );
    expect(paths.metadataPath).toBe(`${paths.helperPath}.build.json`);
  });

  it("overrides ambient helper paths for the macOS backend", () => {
    const env = canonicalFilesystemHelperBackendEnv({
      inheritedEnv: {
        KEEP_ME: "yes",
        [MOSS_CANONICAL_FILESYSTEM_HELPER_PATH_ENV]: "/ambient/helper",
        [MOSS_CANONICAL_FILESYSTEM_HELPER_METADATA_PATH_ENV]: "/ambient/metadata",
      },
      platform: "darwin",
      isPackaged: true,
      resourcesPath: "/Applications/Moss.app/Contents/Resources",
      desktopMainDirname: "/unused",
    });

    expect(env.KEEP_ME).toBe("yes");
    expect(env[MOSS_CANONICAL_FILESYSTEM_HELPER_PATH_ENV]).toBe(
      Path.resolve("/Applications/Moss.app/Contents/Helpers/moss-canonical-filesystem-helper"),
    );
    expect(env[MOSS_CANONICAL_FILESYSTEM_HELPER_METADATA_PATH_ENV]).toBe(
      Path.join(
        "/Applications/Moss.app/Contents/Resources",
        "moss-canonical-filesystem-helper.build.json",
      ),
    );
  });

  it("strips ambient helper paths from unsupported desktop platforms", () => {
    const env = canonicalFilesystemHelperBackendEnv({
      inheritedEnv: {
        KEEP_ME: "yes",
        [MOSS_CANONICAL_FILESYSTEM_HELPER_PATH_ENV]: "/ambient/helper",
        [MOSS_CANONICAL_FILESYSTEM_HELPER_METADATA_PATH_ENV]: "/ambient/metadata",
      },
      platform: "linux",
      isPackaged: true,
      resourcesPath: "/opt/Moss/resources",
      desktopMainDirname: "/unused",
    });

    expect(env).toEqual({ KEEP_ME: "yes" });
  });

  it("wires the controlled runtime env into backendEnv", () => {
    const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

    expect(mainSource).toContain("...canonicalFilesystemHelperBackendEnv({");
    expect(mainSource).toContain("inheritedEnv: process.env");
    expect(mainSource).toContain("isPackaged: app.isPackaged");
    expect(mainSource).toContain("resourcesPath: process.resourcesPath");
  });
});
