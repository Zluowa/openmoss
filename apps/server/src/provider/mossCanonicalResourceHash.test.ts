import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  hashMossCanonicalResource,
  MAX_DEPTH,
  MAX_ENTRIES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  MOSS_CANONICAL_MISSING_HASH,
  READ_CHUNK_BYTES,
} from "./mossCanonicalResourceHash.ts";

type HashLimits = NonNullable<Parameters<typeof hashMossCanonicalResource>[0]["limits"]>;

const roots: string[] = [];
// Successful descriptor hashing needs real POSIX O_NOFOLLOW/O_DIRECTORY.
const posixNoFollowIt = it.skipIf(process.platform === "win32");
const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture(prefix = "moss-canonical-hash-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function hash(
  rootPath: string,
  targetPath: string,
  options: {
    readonly maxFileBytes?: number;
    readonly maxTotalBytes?: number;
    readonly maxEntries?: number;
    readonly maxDepth?: number;
    readonly requirePresent?: boolean;
    readonly hooks?: Parameters<typeof hashMossCanonicalResource>[0]["hooks"];
  } = {},
) {
  const { hooks, requirePresent, maxFileBytes, maxTotalBytes, maxEntries, maxDepth } = options;
  const limits: HashLimits = {
    ...(maxFileBytes !== undefined ? { maxFileBytes } : {}),
    ...(maxTotalBytes !== undefined ? { maxTotalBytes } : {}),
    ...(maxEntries !== undefined ? { maxEntries } : {}),
    ...(maxDepth !== undefined ? { maxDepth } : {}),
  };
  return hashMossCanonicalResource({
    rootPath,
    targetPath,
    limits,
    ...(requirePresent !== undefined ? { requirePresent } : {}),
    ...(hooks !== undefined ? { hooks } : {}),
  });
}

function expectedDirectoryHash(entries: ReadonlyArray<readonly [string, string]>): string {
  return sha256(entries.map(([name, digest]) => `${name}\0${digest}`).join("\n"));
}

describe("bounded canonical resource hash", () => {
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid public hash limit before reading filesystem bytes: %s",
    async (maxFileBytes) => {
      const root = await fixture();
      await expect(hash(root, join(root, "missing"), { maxFileBytes })).rejects.toMatchObject({
        code: "limit-exceeded",
      });
    },
  );

  it.runIf(process.platform === "win32").each(["file", "directory"] as const)(
    "refuses present native %s hashing without no-follow support and preserves source bytes",
    async (kind) => {
      const root = await fixture();
      const directory = join(root, "resource");
      await mkdir(directory);
      const file = join(directory, "file");
      await writeFile(file, "keep-canonical");
      await expect(hash(root, kind === "file" ? file : directory)).rejects.toMatchObject({
        code: "durability-unsupported",
      });
      expect(await readFile(file, "utf8")).toBe("keep-canonical");
    },
  );

  posixNoFollowIt("preserves the existing file and sorted directory digest bytes", async () => {
    const root = await fixture();
    const tree = join(root, "resource");
    const nested = join(tree, "nested");
    await mkdir(nested, { recursive: true });
    await writeFile(join(tree, "z.txt"), "zeta");
    await writeFile(join(tree, "a.txt"), "alpha");
    await writeFile(join(nested, "b.txt"), "bravo");

    const alpha = sha256("alpha");
    const zeta = sha256("zeta");
    const bravo = sha256("bravo");
    const nestedDigest = expectedDirectoryHash([["b.txt", bravo]]);
    const expected = expectedDirectoryHash([
      ["a.txt", alpha],
      ["nested", nestedDigest],
      ["z.txt", zeta],
    ]);

    await expect(hash(root, tree)).resolves.toMatchObject({
      kind: "directory",
      hash: expected,
      bytes: "alpha".length + "zeta".length + "bravo".length,
      entries: 4,
      depth: 2,
    });
    await expect(hash(root, join(tree, "a.txt"))).resolves.toMatchObject({
      kind: "file",
      hash: alpha,
      bytes: 5,
      entries: 1,
      depth: 0,
    });
  });

  it("uses the stable missing digest without treating it as a signature", async () => {
    const root = await fixture();
    const result = await hash(root, join(root, "missing.txt"));

    expect(result).toMatchObject({
      kind: "missing",
      hash: sha256("missing"),
      bytes: 0,
      entries: 0,
      depth: 0,
    });
    expect(result.hash).toBe(MOSS_CANONICAL_MISSING_HASH);
    expect(result.hash).not.toBe("signature");
  });

  posixNoFollowIt.each([
    ["file", "maxFileBytes"],
    ["total", "maxTotalBytes"],
  ] as const)("rejects the %s byte limit at cap plus one", async (kind, limitName) => {
    const root = await fixture(`moss-canonical-hash-${kind}-limit-`);
    const file = join(root, `${kind}.bin`);
    await writeFile(file, Buffer.alloc(5, 0x61));

    const exactLimits =
      kind === "file"
        ? { maxFileBytes: 5, maxTotalBytes: 5 }
        : { maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: 5 };
    await expect(hash(root, file, exactLimits)).resolves.toMatchObject({
      kind: "file",
      bytes: 5,
    });

    await writeFile(file, Buffer.alloc(6, 0x61));
    await expect(hash(root, file, exactLimits)).rejects.toMatchObject({
      code: "limit-exceeded",
    });
    expect(limitName).toMatch(/Bytes$/u);
  });

  posixNoFollowIt("rejects aggregate bytes only after the exact total cap", async () => {
    const root = await fixture("moss-canonical-hash-total-");
    await writeFile(join(root, "a"), Buffer.alloc(3, 0x61));
    await writeFile(join(root, "b"), Buffer.alloc(2, 0x62));
    const limits = { maxFileBytes: 5, maxTotalBytes: 5 };

    await expect(hash(root, root, limits)).resolves.toMatchObject({ bytes: 5 });
    await writeFile(join(root, "c"), Buffer.alloc(1, 0x63));
    await expect(hash(root, root, limits)).rejects.toMatchObject({ code: "limit-exceeded" });
  });

  posixNoFollowIt("enforces exact aggregate entry and depth caps", async () => {
    const root = await fixture("moss-canonical-hash-shape-");
    const nested = join(root, "nested");
    await mkdir(nested);
    await writeFile(join(root, "one"), "1");
    await writeFile(join(nested, "two"), "2");

    await expect(hash(root, root, { maxEntries: 3, maxDepth: 2 })).resolves.toMatchObject({
      entries: 3,
      depth: 2,
    });
    await expect(hash(root, root, { maxEntries: 2, maxDepth: 2 })).rejects.toMatchObject({
      code: "limit-exceeded",
    });
    await expect(hash(root, root, { maxEntries: MAX_ENTRIES, maxDepth: 1 })).rejects.toMatchObject({
      code: "limit-exceeded",
    });
  });

  it("rejects symlink roots, symlink entries, and paths outside the root", async () => {
    const root = await fixture("moss-canonical-hash-links-");
    const outside = await fixture("moss-canonical-hash-outside-");
    const real = join(root, "real");
    await mkdir(real);
    await writeFile(join(real, "file"), "safe");
    await writeFile(join(outside, "file"), "outside");
    if (process.platform === "win32") {
      await symlink(outside, join(root, "entry-link"), "junction");
      expect(await readFile(join(root, "entry-link", "file"), "utf8")).toBe("outside");
    } else await symlink(join(outside, "file"), join(root, "entry-link"));

    await expect(hash(root, join(root, "entry-link"))).rejects.toMatchObject({
      code: "symlink-escape",
    });
    await symlink(
      real,
      join(root, "parent-link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(hash(root, join(root, "parent-link", "file"))).rejects.toMatchObject({
      code: "symlink-escape",
    });
    const rootLink = `${root}-link`;
    roots.push(rootLink);
    await symlink(root, rootLink, process.platform === "win32" ? "junction" : "dir");
    await expect(hash(rootLink, join(rootLink, "real", "file"))).rejects.toMatchObject({
      code: "symlink-escape",
    });
    await expect(hash(root, join(outside, "file"))).rejects.toMatchObject({
      code: "path-traversal",
    });
  });

  posixNoFollowIt(
    "does not inspect symlink ancestors outside the canonical root boundary",
    async () => {
      const physicalParent = await fixture("moss-canonical-hash-physical-parent-");
      const linkContainer = await fixture("moss-canonical-hash-link-container-");
      const linkedParent = join(linkContainer, "parent-link");
      await symlink(physicalParent, linkedParent);
      const root = join(linkedParent, "canonical-root");
      await mkdir(root);
      await writeFile(join(root, "file"), "safe");

      await expect(hash(root, root)).resolves.toMatchObject({
        kind: "directory",
        bytes: 4,
        entries: 1,
        depth: 1,
      });
    },
  );

  posixNoFollowIt(
    "fails closed when the opened entry identity changes during hashing",
    async () => {
      const root = await fixture("moss-canonical-hash-race-");
      const file = join(root, "race.bin");
      const replacement = join(root, "race.replacement");
      await writeFile(file, Buffer.alloc(128 * 1024, 0x61));
      await writeFile(replacement, Buffer.alloc(128 * 1024, 0x62));
      let swapped = false;

      await expect(
        hash(root, file, {
          hooks: {
            beforeRead: async (path) => {
              if (path !== file || swapped) return;
              swapped = true;
              await rm(file);
              await writeFile(file, await readFile(replacement));
            },
          },
        }),
      ).rejects.toMatchObject({ code: "concurrent-modification" });
    },
  );

  it("keeps reads chunked and never uses an unbounded file or parts buffer", async () => {
    const root = await fixture("moss-canonical-hash-stream-");
    const file = join(root, "large.bin");
    await writeFile(file, Buffer.alloc(128 * 1024, 0x61));
    if (process.platform === "win32") {
      await expect(hash(root, file, { maxFileBytes: 128 * 1024 })).rejects.toMatchObject({
        code: "durability-unsupported",
      });
    } else {
      await expect(hash(root, file, { maxFileBytes: 128 * 1024 })).resolves.toMatchObject({
        bytes: 128 * 1024,
      });
    }

    expect(READ_CHUNK_BYTES).toBeLessThanOrEqual(64 * 1024);
    expect(MAX_FILE_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_TOTAL_BYTES).toBe(32 * 1024 * 1024);
    expect(MAX_ENTRIES).toBe(4_096);
    expect(MAX_DEPTH).toBe(32);

    const helperSource = await readFile(
      new URL("./mossCanonicalResourceHash.ts", import.meta.url),
      "utf8",
    );
    expect(helperSource).not.toMatch(/\breadFile(?:Sync)?\b/u);
    expect(helperSource).not.toContain("parts.join");
    expect(helperSource).toContain("READ_CHUNK_BYTES");
  });

  it("wires recovery, native capability, and mutation service to this helper", async () => {
    const sourceFiles = [
      "mossCanonicalResourceRecovery.ts",
      "mossNativeFilesystemCapability.ts",
      "mossCanonicalResourceMutationService.ts",
    ];
    const sources = await Promise.all(
      sourceFiles.map((fileName) => readFile(new URL(`./${fileName}`, import.meta.url), "utf8")),
    );

    for (const source of sources) {
      expect(source).toContain('from "./mossCanonicalResourceHash.ts"');
      expect(source).not.toMatch(/async function hashPath\(/u);
      expect(source).not.toContain("parts.push");
    }
  });

  it("does not expose raw filesystem details from typed filesystem failures", async () => {
    const root = await fixture("moss-canonical-hash-errors-");
    const file = join(root, "error.bin");
    await writeFile(file, "secret-free-test-data");

    const limit = await hash(root, file, { maxFileBytes: 1 }).catch((error: unknown) => error);
    expect(limit).toMatchObject({
      code: process.platform === "win32" ? "durability-unsupported" : "limit-exceeded",
    });
    expect(JSON.stringify(limit)).not.toContain(file);

    const outside = dirname(root);
    const traversal = await hash(root, join(outside, "outside")).catch((error: unknown) => error);
    expect(traversal).toMatchObject({ code: "path-traversal" });
    expect(JSON.stringify(traversal)).not.toContain(outside);
  });
});
