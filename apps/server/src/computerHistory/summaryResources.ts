import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import {
  redactComputerHistoryText,
  type ComputerHistorySummaryResource,
} from "./summaryProjection.ts";

export const COMPUTER_HISTORY_SUMMARY_RESOURCES_DIRECTORY = "resources";
export const COMPUTER_HISTORY_SUMMARY_FILENAME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-f0-9]{16}-(?:10min|6h)-memory-summary\.md$/u;

/**
 * Resources produced by the recursive summary jobs use the same UTC wall
 * clock as the native history stream.  The four-letter component is opaque
 * entropy, while the slug remains useful when inspecting the local folder.
 * Keep this pattern deliberately strict: cleanup must never follow an
 * arbitrary filename supplied by a caller.
 */
export const COMPUTER_HISTORY_JOB_RESOURCE_FILENAME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-z]{4}-(?:10min|6h)-(?=[a-z0-9-]{1,60}\.md$)[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u;

export interface ComputerHistorySummaryJobResource {
  readonly logicalJobKey: string;
  readonly kind: "10min" | "6h";
  readonly startMs: number;
  readonly endMs: number;
  readonly title: string;
  readonly description: string;
  readonly summaryText: string;
  readonly applications: readonly string[];
}

export interface ComputerHistorySummaryJobResourceWriterOptions {
  /** Injected in tests; production maps bytes from the OS CSPRNG. */
  readonly randomAlpha?: (length: number) => string;
  /** A failed write leaves the prior manifest and files untouched. */
  readonly manifestFilename?: string;
}

const DEFAULT_JOB_MANIFEST_FILENAME = "summary-jobs-manifest.json";
const JOB_LOGICAL_KEY_PATTERN = /^(?:10min|6h):\d+$/u;
const JOB_RANDOM_ALPHA_PATTERN = /^[a-z]{4}$/u;
const JOB_SLUG_MAX_LENGTH = 60;

const MAX_RESOURCE_TITLE_LENGTH = 500;
const MAX_RESOURCE_DESCRIPTION_LENGTH = 1_000;
const MAX_RESOURCE_APPLICATIONS = 50;
const MAX_RESOURCE_APPLICATION_LENGTH = 160;
const MAX_RESOURCE_SUMMARY_LENGTH = 2_000;

function resourceRoot(rootDir: string): string {
  return resolve(rootDir, COMPUTER_HISTORY_SUMMARY_RESOURCES_DIRECTORY);
}

export function isComputerHistorySummaryFilename(value: string): boolean {
  return COMPUTER_HISTORY_SUMMARY_FILENAME_PATTERN.test(value);
}

/** Resolve only a generated basename beneath the dedicated resources directory. */
export function resolveComputerHistorySummaryPath(
  rootDir: string,
  filename: string,
): string | null {
  if (!isComputerHistorySummaryFilename(filename)) return null;
  const root = resourceRoot(rootDir);
  const candidate = resolve(root, filename);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;
  return candidate;
}

function safeApplications(values: readonly string[]): string[] {
  return [...new Set(values)]
    .map((value) => redactComputerHistoryText(value, MAX_RESOURCE_APPLICATION_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_RESOURCE_APPLICATIONS);
}

function resourceFrontmatter(resource: ComputerHistorySummaryResource): string {
  const title =
    redactComputerHistoryText(resource.title, MAX_RESOURCE_TITLE_LENGTH) || "Computer History";
  const description =
    redactComputerHistoryText(resource.description, MAX_RESOURCE_DESCRIPTION_LENGTH) ||
    "No additional metadata was captured.";
  const summary =
    redactComputerHistoryText(resource.summaryText, MAX_RESOURCE_SUMMARY_LENGTH) || description;
  const frontmatter: Record<string, unknown> = {
    title,
    description,
    applications: safeApplications(resource.applicationBundleIdentifiers),
  };
  if (resource.suggestion) {
    const suggestionName = redactComputerHistoryText(
      resource.suggestion.name,
      MAX_RESOURCE_DESCRIPTION_LENGTH,
    );
    const suggestionDescription = redactComputerHistoryText(
      resource.suggestion.description,
      MAX_RESOURCE_DESCRIPTION_LENGTH,
    );
    if (suggestionName && suggestionDescription) {
      frontmatter.suggestion = {
        type: resource.suggestion.type,
        name: suggestionName,
        description: suggestionDescription,
      };
    }
  }
  // A JSON object is a YAML flow mapping and avoids adding a parser dependency.
  return `---\n${JSON.stringify(frontmatter)}\n---\n\n${summary}\n`;
}

async function ensureResourceDirectory(rootDir: string): Promise<string> {
  const directory = resourceRoot(rootDir);
  try {
    const existing = await lstat(directory);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error("Computer History summary resources directory is not safe.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await chmod(directory, 0o700);
  return directory;
}

async function atomicWriteResource(path: string, contents: string): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

async function writeResourceIfChanged(path: string, contents: string): Promise<void> {
  try {
    const existing = await lstat(path);
    // lstat deliberately precedes the read: generated resources must never
    // read through a symlink. Non-regular targets are replaced atomically (or
    // fail closed if the filesystem refuses the replacement).
    if (existing.isFile() && !existing.isSymbolicLink()) {
      const currentContents = await readFile(path, "utf8");
      if (currentContents === contents) {
        // Keep the inode and mtime for unchanged resources while restoring the
        // private mode expected for generated summaries.
        await chmod(path, 0o600);
        return;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await atomicWriteResource(path, contents);
}

/**
 * Materialize only generated summary resources. Existing unrelated files are
 * intentionally left untouched; stale cleanup is limited by the strict name
 * pattern above.
 */
export async function syncComputerHistorySummaryResources(
  rootDir: string,
  resources: readonly ComputerHistorySummaryResource[],
): Promise<ReadonlyMap<string, string>> {
  const directory = await ensureResourceDirectory(rootDir);
  const expected = new Set<string>();
  const paths = new Map<string, string>();
  for (const resource of resources) {
    const path = resolveComputerHistorySummaryPath(rootDir, resource.filename);
    if (!path) continue;
    expected.add(resource.filename);
    paths.set(resource.entryId, path);
    await writeResourceIfChanged(path, resourceFrontmatter(resource));
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      entry.isDirectory() ||
      !isComputerHistorySummaryFilename(entry.name) ||
      expected.has(entry.name)
    )
      continue;
    // Never recurse and never delete a file outside the generated basename set.
    await unlink(join(directory, entry.name));
  }
  return paths;
}

export async function removeComputerHistorySummaryResources(rootDir: string): Promise<void> {
  const directory = resourceRoot(rootDir);
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() || !isComputerHistorySummaryFilename(entry.name)) continue;
      await unlink(join(directory, entry.name));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await removeComputerHistorySummaryJobResources(rootDir);
}

export async function readComputerHistorySummaryResource(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export function isComputerHistorySummaryJobResourceFilename(value: string): boolean {
  return COMPUTER_HISTORY_JOB_RESOURCE_FILENAME_PATTERN.test(value);
}

/** Resolve a generated recursive-job basename beneath the local namespace. */
export function resolveComputerHistorySummaryJobResourcePath(
  rootDir: string,
  filename: string,
): string | null {
  if (!isComputerHistorySummaryJobResourceFilename(filename)) return null;
  const root = resourceRoot(rootDir);
  const candidate = resolve(root, filename);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;
  return candidate;
}

/** Read the validated logical-name index used to prove that a recursive file
 * belongs to the currently published snapshot. A missing or malformed
 * manifest fails closed instead of making a loose generated file addressable.
 */
export async function readComputerHistorySummaryJobManifest(
  rootDir: string,
): Promise<ReadonlyMap<string, string>> {
  try {
    const manifest = await readSummaryJobManifest(
      jobManifestPath(rootDir, DEFAULT_JOB_MANIFEST_FILENAME),
    );
    return new Map(Object.entries(manifest.files));
  } catch {
    return new Map();
  }
}

function slugifySummaryJob(value: string): string {
  if (
    /\b(?:https?|ftp|file):\/\//iu.test(value) ||
    /(?:^|[\s(])(?:\/(?:Users|private|var|tmp|Volumes|Applications|home|root|opt|srv|run|System|Library)\/|[A-Za-z]:[\\/])/u.test(
      value,
    ) ||
    /\b[\w.+-]{1,64}@[\w.-]{1,255}\.[A-Za-z]{2,63}\b/u.test(value)
  ) {
    return "summary";
  }
  const slug = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, JOB_SLUG_MAX_LENGTH)
    .replace(/-+$/u, "");
  return slug || "summary";
}

function defaultRandomAlpha(length: number): string {
  const bytes = new Uint8Array(length);
  // The manifest, not the random suffix, owns logical identity and therefore
  // remains stable across updates.
  randomBytes(length).copy(Buffer.from(bytes.buffer));
  return [...bytes].map((byte) => String.fromCharCode(97 + (byte % 26))).join("");
}

function utcJobTimestamp(timestampMs: number): string {
  return new Date(timestampMs)
    .toISOString()
    .replace(/\.\d{3}Z$/u, "")
    .replace(/:/gu, "-")
    .replace(/Z$/u, "");
}

function jobResourceFilename(
  resource: ComputerHistorySummaryJobResource,
  randomAlpha: (length: number) => string,
): string {
  const suffix = randomAlpha(4).toLowerCase();
  if (!JOB_RANDOM_ALPHA_PATTERN.test(suffix)) {
    throw new Error("Computer History summary resource RNG returned unsafe entropy.");
  }
  return `${utcJobTimestamp(resource.startMs)}-${suffix}-${resource.kind}-${slugifySummaryJob(resource.title)}.md`;
}

function jobManifestPath(rootDir: string, filename: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,80}\.json$/u.test(filename)) {
    throw new Error("Computer History summary manifest filename is unsafe.");
  }
  const directory = resourceRoot(rootDir);
  const candidate = resolve(directory, filename);
  if (candidate !== directory && !candidate.startsWith(`${directory}${sep}`)) {
    throw new Error("Computer History summary manifest path escapes its namespace.");
  }
  return candidate;
}

interface SummaryJobManifest {
  readonly version: 1;
  readonly files: Readonly<Record<string, string>>;
}

function parseSummaryJobManifest(value: unknown): SummaryJobManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Computer History summary manifest is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || !candidate.files || typeof candidate.files !== "object") {
    throw new Error("Computer History summary manifest is invalid.");
  }
  const files: Record<string, string> = {};
  for (const [logicalKey, filename] of Object.entries(candidate.files)) {
    if (
      !JOB_LOGICAL_KEY_PATTERN.test(logicalKey) ||
      typeof filename !== "string" ||
      !isComputerHistorySummaryJobResourceFilename(filename)
    ) {
      throw new Error("Computer History summary manifest contains an unsafe entry.");
    }
    files[logicalKey] = filename;
  }
  return { version: 1, files };
}

async function readSummaryJobManifest(path: string): Promise<SummaryJobManifest> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("Computer History summary manifest is not a regular file.");
    }
    return parseSummaryJobManifest(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, files: {} };
    }
    throw error;
  }
}

async function atomicWriteSummaryJobFile(path: string, contents: string): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

async function writeSummaryJobFileIfChanged(path: string, contents: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("Computer History summary resource target is not a regular file.");
    }
    if ((await readFile(path, "utf8")) === contents) {
      await chmod(path, 0o600);
      return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await atomicWriteSummaryJobFile(path, contents);
}

async function summaryJobFileMatches(path: string, contents: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("Computer History summary resource target is not a regular file.");
    }
    return (await readFile(path, "utf8")) === contents;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function summaryJobResourceContents(resource: ComputerHistorySummaryJobResource): string {
  const safeJobText = (value: string, maxLength: number, fallback: string): string => {
    const normalized = redactComputerHistoryText(value, maxLength);
    if (
      !normalized ||
      /\b(?:https?|ftp|file):\/\//iu.test(normalized) ||
      /(?:^|[\s(])(?:\/(?:Users|private|var|tmp|Volumes|Applications|home|root|opt|srv|run|System|Library)\/|[A-Za-z]:[\\/])/u.test(
        normalized,
      ) ||
      /\b[\w.+-]{1,64}@[\w.-]{1,255}\.[A-Za-z]{2,63}\b/u.test(normalized) ||
      /\b(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|password|passwd|secret|credential)\s*[:=]/iu.test(
        normalized,
      )
    ) {
      return fallback;
    }
    return normalized;
  };
  const title = safeJobText(resource.title, MAX_RESOURCE_TITLE_LENGTH, "Summary");
  const description = safeJobText(
    resource.description,
    MAX_RESOURCE_DESCRIPTION_LENGTH,
    "No additional metadata was captured.",
  );
  const summary = safeJobText(resource.summaryText, MAX_RESOURCE_SUMMARY_LENGTH, description);
  const applications = safeApplications(resource.applications).map((application) =>
    /\b(?:https?|ftp|file):\/\//iu.test(application) ||
    /(?:^|[\s(])(?:\/(?:Users|private|var|tmp|Volumes|Applications|home|root|opt|srv|run|System|Library)\/|[A-Za-z]:[\\/])/u.test(
      application,
    )
      ? "Application"
      : application,
  );
  return `---\n${JSON.stringify({ title, description, applications })}\n---\n\n${summary}\n`;
}

/**
 * Atomically materialize recursive job snapshots and their logical-name
 * manifest.  The manifest is written only after all new files succeed; a
 * failed run therefore keeps the previous snapshot addressable.
 */
export async function syncComputerHistorySummaryJobResources(
  rootDir: string,
  resources: readonly ComputerHistorySummaryJobResource[],
  options: ComputerHistorySummaryJobResourceWriterOptions = {},
): Promise<ReadonlyMap<string, string>> {
  const directory = await ensureResourceDirectory(rootDir);
  const manifestFilename = options.manifestFilename ?? DEFAULT_JOB_MANIFEST_FILENAME;
  const manifestPath = jobManifestPath(rootDir, manifestFilename);
  const previous = await readSummaryJobManifest(manifestPath);
  const previousOwners = new Map<string, string>();
  for (const [owner, filename] of Object.entries(previous.files)) {
    previousOwners.set(filename, owner);
  }
  const randomAlpha = options.randomAlpha ?? defaultRandomAlpha;
  const expected = new Set<string>();
  const nextFiles: Record<string, string> = {};
  const paths = new Map<string, string>();
  const seenLogicalKeys = new Set<string>();

  for (const resource of resources) {
    const logicalKey = `${resource.kind}:${resource.startMs}`;
    if (
      !JOB_LOGICAL_KEY_PATTERN.test(logicalKey) ||
      resource.logicalJobKey !== logicalKey ||
      seenLogicalKeys.has(logicalKey) ||
      !Number.isSafeInteger(resource.startMs) ||
      !Number.isSafeInteger(resource.endMs) ||
      resource.endMs <= resource.startMs
    ) {
      throw new Error("Computer History summary resource has an invalid logical key.");
    }
    seenLogicalKeys.add(logicalKey);
    const contents = summaryJobResourceContents(resource);
    const previousFilename = previous.files[logicalKey];
    const previousPath = previousFilename ? resolve(directory, previousFilename) : undefined;
    let filename =
      previousFilename && previousPath && (await summaryJobFileMatches(previousPath, contents))
        ? previousFilename
        : undefined;
    if (!filename) {
      // Changed content receives a fresh suffix.  Keeping the old file until
      // the manifest commit is what makes a failed update retain its LKG.
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const candidate = jobResourceFilename(resource, randomAlpha);
        if (candidate === previousFilename || expected.has(candidate)) continue;
        const candidatePath = resolve(directory, candidate);
        if (previousOwners.has(candidate) && previousOwners.get(candidate) !== logicalKey) {
          continue;
        }
        if (await summaryJobFileMatches(candidatePath, contents)) {
          filename = candidate;
          break;
        }
        try {
          const metadata = await lstat(candidatePath);
          if (metadata.isSymbolicLink() || !metadata.isFile()) {
            throw new Error("Computer History summary resource target is not a regular file.");
          }
          // A different generated file already owns this basename.  Never
          // overwrite it; ask the injected RNG for a new one.
          continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          filename = candidate;
          break;
        }
      }
      if (!filename) {
        throw new Error("Computer History summary resource filename collision.");
      }
    }
    if (!isComputerHistorySummaryJobResourceFilename(filename)) {
      throw new Error("Computer History summary resource filename is unsafe.");
    }
    const path = resolve(directory, filename);
    if (path !== directory && !path.startsWith(`${directory}${sep}`)) {
      throw new Error("Computer History summary resource path escapes its namespace.");
    }
    expected.add(filename);
    nextFiles[logicalKey] = filename;
    paths.set(logicalKey, path);
    await writeSummaryJobFileIfChanged(path, contents);
  }

  const manifestContents = `${JSON.stringify({ version: 1, files: nextFiles })}\n`;
  await writeSummaryJobFileIfChanged(manifestPath, manifestContents);

  // Cleanup is deliberately last. If a resource or the manifest failed above,
  // the previous generated files remain intact and visible. Once the manifest
  // is committed, cleanup is best-effort: stale files cannot change the
  // published snapshot, and a later run can retry their removal.
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        entry.isDirectory() ||
        !isComputerHistorySummaryJobResourceFilename(entry.name) ||
        expected.has(entry.name)
      ) {
        continue;
      }
      const stalePath = join(directory, entry.name);
      const metadata = await lstat(stalePath);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        continue;
      }
      await unlink(stalePath);
    }
  } catch {
    // Do not report a committed manifest as an uncommitted snapshot solely
    // because an old generated file could not be cleaned up.
  }
  return paths;
}

/** Remove only the recursive job namespace and its manifest. */
export async function removeComputerHistorySummaryJobResources(rootDir: string): Promise<void> {
  const directory = resourceRoot(rootDir);
  const manifestPath = jobManifestPath(rootDir, DEFAULT_JOB_MANIFEST_FILENAME);
  try {
    const manifestMetadata = await lstat(manifestPath);
    if (manifestMetadata.isSymbolicLink() || !manifestMetadata.isFile()) {
      throw new Error("Computer History summary manifest is not a regular file.");
    }
    await unlink(manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() || !isComputerHistorySummaryJobResourceFilename(entry.name)) {
        continue;
      }
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error("Computer History summary resource target is not a regular file.");
      }
      await unlink(path);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
