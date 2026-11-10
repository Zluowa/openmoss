// Shared bounded receipt IO only. Provider capabilities and launch eligibility
// remain in their provider-specific helpers; this does not own processes.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { linkSync, lstatSync, readdirSync, unlinkSync, type BigIntStats } from "node:fs";
import { mkdir, open, readdir } from "node:fs/promises";
import path from "node:path";

import { canonicalizeCodexHomeIdentityPath } from "../codexHomeIdentity.ts";
import { readCodexPreparedHomeFileSnapshot } from "../codexProcessEnv.ts";
import {
  PRIVATE_FILE_MODE,
  supportsPosixPermissions,
  syncDirectoryEntry,
} from "../privatePathPermissions.ts";

const RECORD_LIMIT = 8_192;
const REFERENCE_PATTERN = /^[a-f0-9]{64}$/;

export interface AgentStateDirectoryIdentity {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
}

export function agentStateDirectoryIdentity(
  directory: string,
  label: string,
): AgentStateDirectoryIdentity {
  if (!directory.trim() || !path.isAbsolute(directory)) {
    throw new Error(`请选择明确的 ${label} 历史和账户目录后重试。`);
  }
  const stat = lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino === 0n) {
    throw new Error(`${label} 绑定目录已失效，请检查所选目录后重试。`);
  }
  return {
    path: canonicalizeCodexHomeIdentityPath(directory),
    device: String(stat.dev),
    inode: String(stat.ino),
  };
}

export function sameAgentStateDirectory(
  left: AgentStateDirectoryIdentity,
  right: AgentStateDirectoryIdentity,
): boolean {
  return left.path === right.path && left.device === right.device && left.inode === right.inode;
}

export function assertAgentStateDirectoryCurrent(
  identity: AgentStateDirectoryIdentity,
  label: string,
): void {
  if (!sameAgentStateDirectory(identity, agentStateDirectoryIdentity(identity.path, label))) {
    throw new Error(`${label} 绑定目录已移动或被替换，请保留原目录并重新选择账户。`);
  }
}

export function readAgentStateDirectoryFile(
  identity: AgentStateDirectoryIdentity,
  name: string,
  limit: number,
): Buffer | undefined {
  return readCodexPreparedHomeFileSnapshot(
    {
      kind: "bound",
      canonicalHomePath: identity.path,
      device: BigInt(identity.device),
      inode: BigInt(identity.inode),
    },
    name,
    limit,
  );
}

export interface AgentStateBindingRecordHeader {
  readonly version: 1;
  readonly provider: "codex" | "claudeAgent";
  readonly server: AgentStateDirectoryIdentity;
}

/** Keeps the existing Codex signature/reference bytes and 8192-byte limit. */
export function makeAgentStateBindingRecords<T extends AgentStateBindingRecordHeader>(input: {
  readonly provider: T["provider"];
  readonly key: Uint8Array;
  readonly server: AgentStateDirectoryIdentity;
  readonly label: string;
}) {
  const recordDirectory = path.join(input.server.path, "agent-state-bindings", input.provider);
  const sign = (purpose: string, record: T): string =>
    createHmac("sha256", input.key)
      .update(`${purpose}\n`)
      .update(JSON.stringify(record))
      .digest("hex");
  const recordPath = (reference: string) => {
    if (!REFERENCE_PATTERN.test(reference))
      throw new Error(`${input.label} 历史绑定引用无效，请重新选择账户。`);
    return path.join(recordDirectory, `${reference}.json`);
  };
  const assertDirectoriesCurrent = (directories: ReadonlyArray<AgentStateDirectoryIdentity>) => {
    assertAgentStateDirectoryCurrent(input.server, input.label);
    for (const directory of directories) assertAgentStateDirectoryCurrent(directory, input.label);
  };
  const readChild = (parent: AgentStateDirectoryIdentity, name: string) => {
    const directory = agentStateDirectoryIdentity(path.join(parent.path, name), input.label);
    if (path.dirname(directory.path) !== parent.path) {
      throw new Error(`${input.label} 历史绑定目录离开了本服务器，请检查目录后重试。`);
    }
    return directory;
  };
  const bindingDirectories = () => {
    assertDirectoriesCurrent([]);
    const root = readChild(input.server, "agent-state-bindings");
    assertDirectoriesCurrent([root]);
    const directories = [root, readChild(root, input.provider)];
    assertDirectoriesCurrent(directories);
    return directories;
  };
  const prepareBindingDirectories = async () => {
    const directories: AgentStateDirectoryIdentity[] = [];
    let parent = input.server;
    // Never recurse across an unverified ancestor when reserving a private store.
    for (const name of ["agent-state-bindings", input.provider]) {
      assertDirectoriesCurrent(directories);
      try {
        await mkdir(path.join(parent.path, name), { mode: 0o700 });
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      }
      assertDirectoriesCurrent(directories);
      parent = readChild(parent, name);
      directories.push(parent);
    }
    assertDirectoriesCurrent(directories);
    return directories;
  };
  const sameFileData = (left: BigIntStats, right: BigIntStats) =>
    right.isFile() &&
    !right.isSymbolicLink() &&
    right.dev === left.dev &&
    right.ino === left.ino &&
    right.size === left.size &&
    right.mtimeNs === left.mtimeNs &&
    right.mode === left.mode;
  const inspectRecordEntry = (reference: string, directory: string): BigIntStats | undefined => {
    const file = recordPath(reference);
    const entry = lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (!entry) return undefined;
    if (entry.isFile() && !entry.isSymbolicLink() && entry.ino !== 0n) {
      if (entry.nlink === 1n) return entry;
      if (entry.nlink === 2n) {
        // A concurrent publisher (or an interrupted one) can still own the
        // second name. Prove *both* links are here; never trust an external
        // alias or attempt to clean up another publisher's staging file.
        const names = readdirSync(directory);
        if (names.length > 10_000)
          throw new Error(`${input.label} 历史绑定记录过多，请保留目录并联系支持。`);
        const prefix = `.${reference}.`;
        for (const name of names) {
          if (
            !name.startsWith(prefix) ||
            !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/.test(
              name.slice(prefix.length),
            )
          )
            continue;
          const stage = lstatSync(path.join(directory, name), {
            bigint: true,
            throwIfNoEntry: false,
          });
          if (stage?.nlink === 2n && sameFileData(entry, stage)) return entry;
        }
        const completed = lstatSync(file, { bigint: true });
        if (completed.nlink === 1n && sameFileData(entry, completed)) return completed;
      }
    }
    throw new Error(`${input.label} 历史绑定记录包含未知链接，请保留目录并检查链接。`);
  };
  const readExisting = (
    reference: string,
    directories: ReadonlyArray<AgentStateDirectoryIdentity>,
    allowStageClose = true,
  ): T | undefined => {
    const directory = directories[directories.length - 1]!;
    assertDirectoriesCurrent(directories);
    const entry = inspectRecordEntry(reference, directory.path);
    assertDirectoriesCurrent(directories);
    if (!entry) return undefined;
    let bytes: Buffer | undefined;
    try {
      bytes = readAgentStateDirectoryFile(directory, `${reference}.json`, RECORD_LIMIT);
    } catch (cause) {
      // Snapshot IO detects ctime changes; dropping the proven private stage
      // is the only transition for which a single fresh read is warranted.
      assertDirectoriesCurrent(directories);
      const now = inspectRecordEntry(reference, directory.path);
      if (allowStageClose && entry.nlink === 2n && now?.nlink === 1n && sameFileData(entry, now)) {
        return readExisting(reference, directories, false);
      }
      throw cause;
    }
    const after = inspectRecordEntry(reference, directory.path);
    assertDirectoriesCurrent(directories);
    if (
      !bytes ||
      !after ||
      !sameFileData(entry, after) ||
      (after.ctimeNs !== entry.ctimeNs && !(entry.nlink === 2n && after.nlink === 1n))
    ) {
      throw new Error(`${input.label} 历史绑定记录已被替换，请保留目录并重试。`);
    }
    const envelope = JSON.parse(bytes.toString("utf8")) as { record: T; signature: string };
    const record = envelope.record;
    if (
      !record ||
      record.version !== 1 ||
      record.provider !== input.provider ||
      typeof envelope.signature !== "string" ||
      !REFERENCE_PATTERN.test(envelope.signature) ||
      !timingSafeEqual(
        Buffer.from(envelope.signature, "hex"),
        Buffer.from(sign("signature", record), "hex"),
      ) ||
      sign("reference", record) !== reference ||
      !sameAgentStateDirectory(record.server, input.server)
    ) {
      throw new Error(`${input.label} 历史绑定记录无法验证，请重新选择原账户。`);
    }
    return record;
  };
  return {
    async listReferences(): Promise<ReadonlyArray<string>> {
      assertAgentStateDirectoryCurrent(input.server, input.label);
      let directories: ReadonlyArray<AgentStateDirectoryIdentity>;
      try {
        directories = bindingDirectories();
      } catch (cause) {
        assertAgentStateDirectoryCurrent(input.server, input.label);
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw cause;
      }
      const entries = await readdir(directories[directories.length - 1]!.path);
      if (entries.length > 10_000)
        throw new Error(`${input.label} 历史绑定记录过多，请保留目录并联系支持。`);
      assertDirectoriesCurrent(directories);
      return entries
        .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
        .map((name) => name.slice(0, -5));
    },
    read(reference: string): T {
      recordPath(reference);
      const record = readExisting(reference, bindingDirectories());
      if (!record)
        throw new Error(`${input.label} 历史绑定记录已丢失，请保留历史目录并重新选择账户。`);
      return record;
    },
    async publish(record: T): Promise<string> {
      if (
        record.provider !== input.provider ||
        !sameAgentStateDirectory(record.server, input.server)
      ) {
        throw new Error(`${input.label} 历史绑定所属服务器或程序不一致。`);
      }
      const reference = sign("reference", record);
      const directories = await prepareBindingDirectories();
      if (readExisting(reference, directories)) return reference;
      const directory = directories[directories.length - 1]!;
      if (supportsPosixPermissions() && (lstatSync(directory.path).mode & 0o022) !== 0) {
        throw new Error(`${input.label} 历史绑定目录可被其他用户修改，请检查目录权限。`);
      }
      const contents = JSON.stringify({ record, signature: sign("signature", record) });
      if (Buffer.byteLength(contents) > RECORD_LIMIT)
        throw new Error(`${input.label} 历史绑定记录超过大小限制。`);
      const stage = path.join(directory.path, `.${reference}.${randomUUID()}.tmp`);
      const handle = await open(stage, "wx", PRIVATE_FILE_MODE);
      let owned: BigIntStats | undefined;
      const assertStage = () => {
        assertDirectoriesCurrent(directories);
        const entry = lstatSync(stage, { bigint: true });
        if (
          !owned ||
          !entry.isFile() ||
          entry.isSymbolicLink() ||
          owned.ino === 0n ||
          entry.dev !== owned.dev ||
          entry.ino !== owned.ino
        ) {
          throw new Error(`${input.label} 临时绑定文件已被替换，请保留目录并重试。`);
        }
      };
      try {
        try {
          owned = await handle.stat({ bigint: true });
          assertStage();
          if (supportsPosixPermissions()) await handle.chmod(PRIVATE_FILE_MODE);
          await handle.writeFile(contents);
          await handle.sync();
        } finally {
          await handle.close();
        }
        assertStage();
        // A same-volume hard link atomically exposes complete bytes only if
        // the final name is free. Never replace an immutable receipt.
        try {
          linkSync(stage, recordPath(reference));
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
            throw new Error(
              `${input.label} 无法安全创建历史绑定记录，请检查服务器状态目录是否支持硬链接及写入权限。`,
              { cause },
            );
          }
        }
      } finally {
        if (owned) {
          assertStage();
          unlinkSync(stage);
        }
      }
      if (!readExisting(reference, directories))
        throw new Error(`${input.label} 历史绑定记录发布失败，请重试。`);
      await syncDirectoryEntry(directory.path);
      assertDirectoriesCurrent(directories);
      return reference;
    },
  };
}
