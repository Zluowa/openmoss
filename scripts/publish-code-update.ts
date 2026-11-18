// FILE: publish-code-update.ts
// Purpose: Uploads a signed code update to every download store, and prunes old packages from them.
//          Both are dry runs unless asked: uploading is the lead's step with the owner's yes, and
//          pruning deletes production objects permanently (the owner's yes, every time).
// Usage:   bun run scripts/publish-code-update.ts upload --out <build-code-update output> --channel preview [--publish]
//          bun run scripts/publish-code-update.ts prune [--keep-hours 24] [--apply]
//          Store settings as for scripts/upload-moss-runtimes.ts (one settings folder per store).
// Rules:   scripts/lib/code-update-publish.ts; CODE-UPDATES.md §11.

import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import type { CodeUpdateChannel } from "@moss/shared/codeUpdate";

import {
  pruneCodeUpdateStore,
  readLocalCodeUpdate,
  uploadCodeUpdate,
  type CodeUpdateStore,
  type CodeUpdateStoreTarget,
} from "./lib/code-update-publish.ts";
import { runtimeSourceBaseUrl } from "./lib/runtime-archive-check.ts";
import { resolveUpdateMirrorStores } from "./lib/update-mirror-stores.ts";
import {
  describeUpdateMirrorStoreList,
  readUpdateMirrorS3ClientOptions,
} from "./sync-update-mirror.ts";

const UPLOAD_RETRIES = 3;

function createS3CodeUpdateStore(
  env: Readonly<Record<string, string | undefined>>,
): CodeUpdateStore {
  const client = new Bun.S3Client(readUpdateMirrorS3ClientOptions(env));
  return {
    upload: async (key, localPath, contentType) => {
      await client
        .file(key)
        .write(Bun.file(localPath), { type: contentType, retry: UPLOAD_RETRIES });
    },
    sizeOf: async (key) => {
      try {
        return (await client.file(key).stat()).size;
      } catch {
        return null;
      }
    },
    list: async (prefix) => {
      const objects: Array<{ key: string; size: number; lastModified: Date }> = [];
      let continuationToken: string | undefined;
      do {
        const page = await client.list({
          prefix,
          ...(continuationToken ? { continuationToken } : {}),
        });
        for (const entry of page.contents ?? []) {
          objects.push({
            key: entry.key,
            size: entry.size ?? 0,
            lastModified: new Date(entry.lastModified ?? 0),
          });
        }
        continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
      } while (continuationToken);
      return objects;
    },
    delete: async (key) => {
      await client.file(key).delete();
    },
  };
}

export async function resolveCodeUpdateTargets(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
  readonly createStore?: (env: Readonly<Record<string, string | undefined>>) => CodeUpdateStore;
  readonly log: (line: string) => void;
}): Promise<CodeUpdateStoreTarget[]> {
  const resolution = await resolveUpdateMirrorStores({
    env: input.env,
    homeDirectory: input.homeDirectory,
    files: ["update-mirror.env", "update-mirror-upload.env"],
  });
  const note = describeUpdateMirrorStoreList(resolution);
  if (note) input.log(note);
  return resolution.stores.map((store) => ({
    label: store.label,
    store: (input.createStore ?? createS3CodeUpdateStore)(store.env),
    publicBaseUrl: runtimeSourceBaseUrl(store.env, { severalStores: resolution.severalStores }),
  }));
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" },
      channel: { type: "string", default: "preview" },
      publish: { type: "boolean", default: false },
      apply: { type: "boolean", default: false },
      "keep-hours": { type: "string", default: "24" },
    },
  });
  const log = (line: string) => console.log(`[code-update-publish] ${line}`);
  const targets = await resolveCodeUpdateTargets({
    env: process.env,
    homeDirectory: homedir(),
    log,
  });
  if (positionals[0] === "upload") {
    if (!values.out) throw new Error("upload needs --out <build-code-update output>");
    const local = await readLocalCodeUpdate(
      resolve(values.out),
      values.channel as CodeUpdateChannel,
    );
    const result = await uploadCodeUpdate({ local, targets, publish: values.publish, log });
    return values.publish && !result.published ? 1 : 0;
  }
  if (positionals[0] === "prune") {
    const keepHours = Number(values["keep-hours"]);
    if (!Number.isFinite(keepHours) || keepHours < 24) {
      throw new Error("--keep-hours must be at least 24");
    }
    for (const target of targets) {
      await pruneCodeUpdateStore({ target, apply: values.apply, keepHours, log });
    }
    return 0;
  }
  throw new Error("command: upload | prune");
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(
        `[code-update-publish] ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    },
  );
}
