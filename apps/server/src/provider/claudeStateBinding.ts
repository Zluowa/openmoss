// Server-issued Claude projects bindings. Native projects may be shared;
// HOME/config/credentials remain private and no existing projects are replaced.
import { createHmac } from "node:crypto";
import { lstatSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { lstat, mkdir, readdir } from "node:fs/promises";
import {
  configuredHomeDirectory,
  normalizeEnvironmentKeys,
} from "@moss/shared/platformEnvironment";
import { createDirectoryLink } from "@moss/shared/filesystemPlatform";
import path from "node:path";
import { Effect, Option } from "effect";
import type { ProviderStartOptions, ServerSettings } from "@moss/contracts";
import {
  deriveConfiguredProviderInstances,
  providerStartOptionsFromInstance,
  resolveProviderInstance,
  type ResolvedProviderInstance,
} from "@moss/shared/providerInstances";

import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { canonicalizeCodexHomeIdentityPath } from "../codexHomeIdentity.ts";
import { isVerifiedMossManagedClaudeProviderInstance } from "./claudeEnvironment.ts";
import {
  agentStateDirectoryIdentity as directory,
  assertAgentStateDirectoryCurrent as assertCurrent,
  makeAgentStateBindingRecords,
  readAgentStateDirectoryFile,
  sameAgentStateDirectory as sameDirectory,
  type AgentStateDirectoryIdentity as DirectoryIdentity,
} from "./agentStateBindingRecords.ts";

const LABEL = "Claude";
const KEY = "claude-state-bindings-hmac-v1";
type ClaudeOptions = NonNullable<ProviderStartOptions["claudeAgent"]>;

export interface ClaudeStateBindingAccount {
  readonly providerInstanceId: string;
  readonly enabled: boolean;
  readonly sourceProjectsPath: string;
  readonly homePath: string;
  readonly configPath: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly runtimeGeneration?: string;
  /** Only a verified server-managed instance may use a new generated home. */
  readonly managed: boolean;
}

function explicitClaudeRoots(instance: ResolvedProviderInstance) {
  const options = providerStartOptionsFromInstance(instance)?.claudeAgent;
  const selected = normalizeEnvironmentKeys(options?.environment ?? {});
  const homePath = options?.homePath?.trim() || configuredHomeDirectory(selected) || "";
  const configPath =
    selected.CLAUDE_CONFIG_DIR?.trim() || (homePath ? path.join(homePath, ".claude") : "");
  const securePath = selected.CLAUDE_SECURESTORAGE_CONFIG_DIR?.trim();
  return {
    homePath,
    configPath,
    securePath,
    environment: options?.environment === undefined ? undefined : selected,
  };
}

/** Explicit current server settings only: never infer an account from ambient HOME. */
export function claudeStateBindingAccountFromSettings(
  settings: ServerSettings,
  providerInstanceId: string,
  env?: Readonly<Record<string, string | undefined>>,
): ClaudeStateBindingAccount | undefined {
  const instance = resolveProviderInstance(settings, {
    instanceId: providerInstanceId,
    provider: "claudeAgent",
  });
  if (!instance) return undefined;
  const managed = isVerifiedMossManagedClaudeProviderInstance({
    instanceId: instance.instanceId,
    instance: instance.raw,
    ...(env ? { env } : {}),
  });
  if (!managed && (instance.config.managed === true || instance.instanceId === "claude_moss")) {
    throw new Error("Claude 管理账户配置无法验证，请重新连接 Moss 账户。");
  }
  const roots = explicitClaudeRoots(instance);
  if (!managed) {
    if (
      !roots.homePath ||
      !path.isAbsolute(roots.homePath) ||
      !path.isAbsolute(roots.configPath) ||
      (roots.securePath && !path.isAbsolute(roots.securePath))
    ) {
      throw new Error(
        "共享 Claude 历史前，请在账户设置中明确选择绝对路径的私有 HOME 和配置目录；原对话仍保留原目录。",
      );
    }
    const privatePaths = [roots.homePath, roots.configPath, roots.securePath]
      .filter((value): value is string => Boolean(value))
      .map(canonicalizeCodexHomeIdentityPath);
    for (const other of deriveConfiguredProviderInstances(settings)) {
      if (
        other.driver !== "claudeAgent" ||
        other.instanceId === instance.instanceId ||
        isVerifiedMossManagedClaudeProviderInstance({
          instanceId: other.instanceId,
          instance: other.raw,
          ...(env ? { env } : {}),
        })
      )
        continue;
      const otherRoots = explicitClaudeRoots(other);
      for (const candidate of [otherRoots.homePath, otherRoots.configPath, otherRoots.securePath]) {
        if (!candidate || !path.isAbsolute(candidate)) continue;
        const otherPath = canonicalizeCodexHomeIdentityPath(candidate);
        if (
          privatePaths.some((ownPath) => inside(ownPath, otherPath) || inside(otherPath, ownPath))
        ) {
          throw new Error(
            `Claude 账户“${instance.displayName}”与“${other.displayName}”共用私有目录，请为每个账户选择独立 HOME、配置和凭据目录。`,
          );
        }
      }
    }
  }
  return {
    providerInstanceId: instance.instanceId,
    managed,
    enabled: instance.enabled && settings.providers.claudeAgent.enabled,
    sourceProjectsPath: settings.providers.claudeAgent.sharedProjectsPath.trim(),
    homePath: roots.homePath,
    configPath: roots.configPath,
    ...(roots.environment !== undefined ? { environment: roots.environment } : {}),
    ...(managed ? { runtimeGeneration: instance.config.runtimeGeneration as string } : {}),
  };
}

interface ClaudeBindingRecord {
  readonly version: 1;
  readonly provider: "claudeAgent";
  readonly providerInstanceId: string;
  readonly server: DirectoryIdentity;
  readonly source: DirectoryIdentity;
  readonly home: DirectoryIdentity;
  readonly private: DirectoryIdentity;
  readonly secure?: DirectoryIdentity;
  readonly sourceGeneration: string;
  readonly runtimeGeneration: string;
  readonly managed: boolean;
}

/** This brand is independent of Codex credential capabilities. */
export interface ClaudeStateBindingCapability {
  readonly provider: "claudeAgent";
}
export type ClaudeStateBindingOptions = ClaudeOptions & {
  readonly stateBinding?: ClaudeStateBindingCapability;
};
interface IssuedClaudeBinding {
  readonly reference: string;
  readonly record: ClaudeBindingRecord;
  readonly assertValid: (options: ClaudeStateBindingOptions, launch: boolean) => void;
}
const issued = new WeakMap<ClaudeStateBindingCapability, IssuedClaudeBinding>();

export function readClaudeStateBinding(
  options: ClaudeStateBindingOptions | undefined,
  launch = true,
) {
  if (!options || options.stateBinding === undefined) return undefined;
  const capability = options.stateBinding;
  const binding = capability && typeof capability === "object" ? issued.get(capability) : undefined;
  if (!binding) throw new Error("Claude 历史绑定无效，请重新打开原对话。");
  binding.assertValid(options, launch);
  return binding;
}

export function claudeStateBindingReference(
  options: ClaudeStateBindingOptions | undefined,
): string | undefined {
  return readClaudeStateBinding(options, false)?.reference;
}

export interface ClaudeStateBindingRestore {
  readonly providerInstanceId: string;
  readonly reference?: string;
  /** The existing server-owned thread reference, never an incoming client ref. */
  readonly expectedReference?: string;
}
export interface ClaudeStateBindingAccess {
  readonly reference: string;
  readonly sourceGeneration: string;
  readonly options: ClaudeStateBindingOptions;
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function assertProjectsBoundary(privateRoot: DirectoryIdentity, source: DirectoryIdentity): void {
  const projects = path.join(privateRoot.path, "projects");
  if (
    inside(source.path, privateRoot.path) ||
    (inside(privateRoot.path, source.path) && source.path !== projects)
  ) {
    throw new Error("Claude 共享源只能是 projects 历史目录，不能包含账户配置或凭据目录。");
  }
}

function verifyProjects(privateRoot: DirectoryIdentity, source: DirectoryIdentity): void {
  assertCurrent(privateRoot, LABEL);
  assertCurrent(source, LABEL);
  assertProjectsBoundary(privateRoot, source);
  const projects = path.join(privateRoot.path, "projects");
  const actual = directory(realpathSync(projects), LABEL);
  if (!sameDirectory(actual, source)) {
    throw new Error(
      "此 Claude 账户已有其他历史目录；请选择原 projects 作为共享源，或为新对话选择新的私有账户目录。原历史不会移动。",
    );
  }
}

async function prepareProjects(
  privateRoot: DirectoryIdentity,
  source: DirectoryIdentity,
): Promise<void> {
  assertCurrent(privateRoot, LABEL);
  assertCurrent(source, LABEL);
  assertProjectsBoundary(privateRoot, source);
  const projects = path.join(privateRoot.path, "projects");
  try {
    await lstat(projects);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    // No replacement, directory removal, recursive history scan or migration.
    assertCurrent(privateRoot, LABEL);
    assertCurrent(source, LABEL);
    try {
      await createDirectoryLink(source.path, projects);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  verifyProjects(privateRoot, source);
}

function environmentKey(environment: Readonly<Record<string, string>> | undefined): string {
  return JSON.stringify(
    Object.entries(environment ?? {}).toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

export const makeClaudeStateBindingAccess = (input: {
  readonly stateDir: string;
  readonly readAccount: (instanceId: string) => ClaudeStateBindingAccount | undefined;
}) =>
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore;
    const key = yield* secrets.getOrCreateRandom(KEY, 32);
    const server = directory(input.stateDir, LABEL);
    const records = makeAgentStateBindingRecords<ClaudeBindingRecord>({
      provider: "claudeAgent",
      key,
      server,
      label: LABEL,
    });
    const digest = (purpose: string, value: unknown) =>
      createHmac("sha256", key).update(`${purpose}\n`).update(JSON.stringify(value)).digest("hex");
    const sourceGeneration = (source: DirectoryIdentity) => digest("projects-generation", source);

    const accountForLaunch = (instanceId: string) => {
      const account = input.readAccount(instanceId);
      if (!account || account.providerInstanceId !== instanceId)
        throw new Error("Claude 账户已移除，请重新选择账户。");
      if (!account.enabled) throw new Error("Claude 账户已停用，请启用账户后重试。");
      if (account.managed && !account.runtimeGeneration?.trim())
        throw new Error("Claude 管理账户代际无效，请重新连接账户。");
      return account;
    };
    const managedParts = (account: ClaudeStateBindingAccount, generation: string) => [
      "provider-homes",
      "claude-shared",
      Buffer.from(account.providerInstanceId, "utf8").toString("hex"),
      generation,
      ".claude",
    ];
    const prepareManagedRoots = async (account: ClaudeStateBindingAccount, generation: string) => {
      let parent = server;
      for (const part of managedParts(account, generation)) {
        assertCurrent(parent, LABEL);
        const target = path.join(parent.path, part);
        try {
          await mkdir(target, { mode: 0o700 });
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
        }
        assertCurrent(parent, LABEL);
        const child = directory(target, LABEL);
        if (path.dirname(child.path) !== parent.path)
          throw new Error("Claude 私有目录离开了本服务器，请检查目录后重试。");
        parent = child;
      }
    };
    const privateRoots = (account: ClaudeStateBindingAccount, generation: string) => {
      let homePath = account.homePath;
      let configPath = account.configPath;
      if (account.managed) {
        let current = server.path;
        // Walk only server-derived components; reject existing aliases before
        // creating descendants. Never create in an ambient or caller-owned home.
        for (const part of managedParts(account, generation)) {
          assertCurrent(directory(current, LABEL), LABEL);
          current = path.join(current, part);
          const identity = directory(current, LABEL);
          if (!inside(server.path, identity.path))
            throw new Error("Claude 私有目录离开了本服务器，请检查目录后重试。");
        }
        configPath = current;
        homePath = path.dirname(current);
      }
      const home = directory(homePath, LABEL);
      const privateRoot = directory(configPath, LABEL);
      const securePath = account.managed
        ? undefined
        : account.environment?.CLAUDE_SECURESTORAGE_CONFIG_DIR?.trim();
      const secure = securePath ? directory(securePath, LABEL) : undefined;
      const managedHomes = path.join(server.path, "provider-homes", "claude-shared");
      if (
        !account.managed &&
        [home, privateRoot, secure].some(
          (root) => root && (inside(managedHomes, root.path) || inside(root.path, managedHomes)),
        )
      ) {
        throw new Error("Claude 的 Moss 管理目录不能用作本机账户的私有目录，请选择独立目录。");
      }
      return { home, private: privateRoot, ...(secure ? { secure } : {}) };
    };
    const runtimeGeneration = (
      account: ClaudeStateBindingAccount,
      roots: ReturnType<typeof privateRoots>,
    ) => {
      if (account.managed) return account.runtimeGeneration!;
      const credentials = roots.secure ?? roots.private;
      const authFile = path.join(credentials.path, ".credentials.json");
      const revision = () => {
        try {
          const stat = lstatSync(authFile, { bigint: true });
          return [
            String(stat.dev),
            String(stat.ino),
            String(stat.mtimeNs),
            String(stat.ctimeNs),
            String(stat.size),
          ];
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT") return ["missing"];
          throw cause;
        }
      };
      const before = revision();
      const auth = readAgentStateDirectoryFile(credentials, ".credentials.json", 1_048_576);
      if (JSON.stringify(before) !== JSON.stringify(revision()))
        throw new Error("Claude 认证在读取时发生变化，请重试。");
      return digest("account-generation", [
        account.providerInstanceId,
        roots,
        before,
        auth?.toString("base64") ?? null,
        environmentKey(account.environment),
      ]);
    };
    const readRecord = (
      reference: string,
      instanceId: string,
      mode: "all" | "source" | "ownership" = "all",
    ) => {
      const record = records.read(reference);
      if (record.providerInstanceId !== instanceId)
        throw new Error("Claude 历史绑定不属于所选账户，请重新选择原账户。");
      if (mode === "ownership") return record;
      assertCurrent(record.source, LABEL);
      if (sourceGeneration(record.source) !== record.sourceGeneration)
        throw new Error("Claude 历史来源已更换，请保留原目录后重试。");
      if (mode === "all") {
        assertCurrent(record.home, LABEL);
        assertCurrent(record.private, LABEL);
        if (record.secure) assertCurrent(record.secure, LABEL);
        verifyProjects(record.private, record.source);
      }
      return record;
    };
    const expectedOptions = (
      record: ClaudeBindingRecord,
      account: ClaudeStateBindingAccount | undefined,
    ): ClaudeOptions => ({
      homePath: record.home.path,
      // Managed selected env keeps its exact server-verified three-key shape.
      environment: record.managed
        ? { ...account?.environment }
        : {
            ...account?.environment,
            CLAUDE_CONFIG_DIR: record.private.path,
            ...(record.secure ? { CLAUDE_SECURESTORAGE_CONFIG_DIR: record.secure.path } : {}),
          },
    });
    const assertLaunch = (record: ClaudeBindingRecord) => {
      const account = accountForLaunch(record.providerInstanceId);
      const roots = privateRoots(account, record.sourceGeneration);
      if (
        account.managed !== record.managed ||
        !sameDirectory(roots.home, record.home) ||
        !sameDirectory(roots.private, record.private) ||
        JSON.stringify(roots.secure ?? null) !== JSON.stringify(record.secure ?? null) ||
        runtimeGeneration(account, roots) !== record.runtimeGeneration
      ) {
        throw new Error("Claude 账户绑定已更换，请重新连接账户并保留当前历史。");
      }
      return account;
    };
    const accessFor = (
      reference: string,
      record: ClaudeBindingRecord,
      stopOnly = false,
    ): ClaudeStateBindingAccess => {
      const capability: ClaudeStateBindingCapability = Object.freeze({ provider: "claudeAgent" });
      issued.set(capability, {
        reference,
        record,
        assertValid: (options, launch) => {
          // A previously issued process capability remains proof for exact-session
          // teardown after its files are deleted. It never authorizes another spawn.
          if (options.homePath !== record.home.path)
            throw new Error("Claude 账户路径与服务器绑定不一致，请重新打开对话。");
          if (!launch) return;
          if (stopOnly) throw new Error("此 Claude 绑定仅用于停止旧会话，请重新选择账户后启动。");
          readRecord(reference, record.providerInstanceId);
          const account = assertLaunch(record);
          const expected = expectedOptions(record, account);
          if (environmentKey(options.environment) !== environmentKey(expected.environment)) {
            throw new Error("Claude 账户路径或配置与服务器绑定不一致，请重新打开对话。");
          }
        },
      });
      return {
        reference,
        sourceGeneration: record.sourceGeneration,
        options: {
          ...(stopOnly
            ? { homePath: record.home.path }
            : expectedOptions(record, input.readAccount(record.providerInstanceId))),
          stateBinding: capability,
        },
      };
    };
    const selectedRecord = (
      request: ClaudeStateBindingRestore,
      mode: "all" | "source" | "ownership" = "all",
    ) => {
      if (request.reference === undefined && request.expectedReference === undefined)
        return undefined;
      if (!request.reference || request.reference !== request.expectedReference)
        throw new Error("Claude 历史绑定与当前对话不一致，请重新打开原对话。");
      return {
        reference: request.reference,
        record: readRecord(request.reference, request.providerInstanceId, mode),
      };
    };
    const publish = async (
      account: ClaudeStateBindingAccount,
      source: DirectoryIdentity,
      original?: ClaudeBindingRecord,
      newSelection = false,
    ) => {
      const generation = sourceGeneration(source);
      if (account.managed) await prepareManagedRoots(account, generation);
      const roots = privateRoots(account, generation);
      if (
        inside(source.path, roots.home.path) ||
        (roots.secure && inside(source.path, roots.secure.path))
      ) {
        throw new Error("Claude 共享历史不能包含私有账户或凭据目录，请选择 projects 目录。");
      }
      if (original) {
        if (original.home.path === roots.home.path) assertCurrent(original.home, LABEL);
        if (original.private.path === roots.private.path) assertCurrent(original.private, LABEL);
        if (original.secure && original.secure.path === roots.secure?.path)
          assertCurrent(original.secure, LABEL);
        if (
          original.providerInstanceId !== account.providerInstanceId &&
          (original.home.path === roots.home.path ||
            original.private.path === roots.private.path ||
            (original.secure && original.secure.path === roots.secure?.path))
        ) {
          throw new Error("不同 Claude 账户不能共用私有配置目录，请为目标账户选择独立目录。");
        }
      }
      const record: ClaudeBindingRecord = {
        version: 1,
        provider: "claudeAgent",
        providerInstanceId: account.providerInstanceId,
        server,
        source,
        ...roots,
        sourceGeneration: generation,
        runtimeGeneration: runtimeGeneration(account, roots),
        managed: account.managed,
      };
      const assertSourceSelection = () => {
        if (
          newSelection &&
          !sameDirectory(
            source,
            directory(accountForLaunch(account.providerInstanceId).sourceProjectsPath, LABEL),
          )
        ) {
          throw new Error("Claude 共享历史设置在绑定时发生变化，请重试。");
        }
      };
      assertLaunch(record);
      assertSourceSelection();
      const reference = await records.publish(record);
      assertLaunch(record);
      assertSourceSelection();
      await prepareProjects(roots.private, source);
      readRecord(reference, account.providerInstanceId);
      assertLaunch(record);
      assertSourceSelection();
      return accessFor(reference, record);
    };
    return {
      async clearManagedPrivateState(input: {
        readonly providerInstanceId: string;
        readonly assertAccountDisabled: () => void;
        readonly assertPrivateIdle: (privateConfigPath: string) => void;
      }): Promise<void> {
        input.assertAccountDisabled();
        const managed = new Map<string, ClaudeBindingRecord>();
        for (const reference of await records.listReferences()) {
          const record = records.read(reference);
          if (!record.managed || record.providerInstanceId !== input.providerInstanceId) continue;
          assertCurrent(record.source, LABEL);
          if (sourceGeneration(record.source) !== record.sourceGeneration)
            throw new Error("Claude 历史来源无法验证，未清理私有目录。");
          const roots = privateRoots(
            {
              providerInstanceId: record.providerInstanceId,
              managed: true,
              enabled: false,
              homePath: "",
              configPath: "",
              sourceProjectsPath: record.source.path,
            },
            record.sourceGeneration,
          );
          if (
            !sameDirectory(roots.home, record.home) ||
            !sameDirectory(roots.private, record.private)
          ) {
            throw new Error("Claude 私有目录已被替换，未清理；请保留目录并重新选择账户。");
          }
          verifyProjects(record.private, record.source);
          if (!(await lstat(path.join(record.private.path, "projects"))).isSymbolicLink()) {
            throw new Error("Claude 托管历史链接已被替换，未清理私有目录。");
          }
          input.assertPrivateIdle(record.private.path);
          managed.set(record.home.path, record);
        }
        let ownedParent = server;
        for (const name of [
          "provider-homes",
          "claude-shared",
          Buffer.from(input.providerInstanceId, "utf8").toString("hex"),
        ]) {
          const target = path.join(ownedParent.path, name);
          let child: DirectoryIdentity;
          try {
            child = directory(target, LABEL);
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ENOENT" && managed.size === 0) return;
            throw cause;
          }
          if (path.dirname(child.path) !== ownedParent.path)
            throw new Error("Claude 私有目录离开了本服务器，未清理。");
          ownedParent = child;
        }
        for (const name of await readdir(ownedParent.path)) {
          assertCurrent(ownedParent, LABEL);
          const child = directory(path.join(ownedParent.path, name), LABEL);
          if (!managed.has(child.path))
            throw new Error("Claude 私有目录缺少已验证绑定记录，未清理；请保留目录并联系支持。");
        }
        // Preflight every entry before deleting anything. Preserve root inodes so
        // a new credential generation can rebind an old thread after sign-out.
        const removals: Array<{
          path: string;
          parent: DirectoryIdentity;
          record: ClaudeBindingRecord;
          device: bigint;
          inode: bigint;
          ctimeNs: bigint;
          directory: boolean;
        }> = [];
        const walk = async (
          current: DirectoryIdentity,
          record: ClaudeBindingRecord,
          depth: number,
        ): Promise<void> => {
          if (depth > 32) throw new Error("Claude 私有目录层级过深，未清理；请联系支持。");
          assertCurrent(current, LABEL);
          for (const name of await readdir(current.path)) {
            assertCurrent(current, LABEL);
            const target = path.join(current.path, name);
            if (target === path.join(record.private.path, "projects")) continue;
            const stat = await lstat(target, { bigint: true });
            assertCurrent(current, LABEL);
            if (
              stat.isSymbolicLink() ||
              (!stat.isFile() && !stat.isDirectory()) ||
              stat.ino === 0n
            ) {
              throw new Error(
                "Claude 私有目录包含未验证链接或文件，未清理；请保留目录并联系支持。",
              );
            }
            if (stat.isDirectory()) await walk(directory(target, LABEL), record, depth + 1);
            if (target !== record.private.path)
              removals.push({
                path: target,
                parent: current,
                record,
                device: stat.dev,
                inode: stat.ino,
                ctimeNs: stat.ctimeNs,
                directory: stat.isDirectory(),
              });
            if (removals.length > 10_000)
              throw new Error("Claude 私有目录条目过多，未清理；请联系支持。");
          }
          assertCurrent(current, LABEL);
        };
        for (const record of managed.values()) await walk(record.home, record, 0);
        input.assertAccountDisabled();
        for (const entry of removals) {
          // Keep the final disabled/idle and path checks contiguous with unlink/rmdir.
          // A new launch could acquire the private home across an await.
          input.assertAccountDisabled();
          const record = entry.record;
          assertCurrent(record.home, LABEL);
          assertCurrent(record.private, LABEL);
          verifyProjects(record.private, record.source);
          input.assertPrivateIdle(record.private.path);
          assertCurrent(entry.parent, LABEL);
          const stat = lstatSync(entry.path, { bigint: true });
          if (
            stat.isSymbolicLink() ||
            stat.dev !== entry.device ||
            stat.ino !== entry.inode ||
            (!entry.directory && stat.ctimeNs !== entry.ctimeNs) ||
            stat.isDirectory() !== entry.directory
          )
            throw new Error("Claude 私有内容在清理期间发生变化，请保留目录并重试。");
          if (entry.directory) rmdirSync(entry.path);
          else unlinkSync(entry.path);
        }
        for (const record of managed.values()) {
          assertCurrent(record.home, LABEL);
          assertCurrent(record.private, LABEL);
          verifyProjects(record.private, record.source);
        }
      },
      register: async (providerInstanceId: string) => {
        const account = accountForLaunch(providerInstanceId);
        return publish(account, directory(account.sourceProjectsPath, LABEL), undefined, true);
      },
      rebind: async (
        request: ClaudeStateBindingRestore,
        providerInstanceId = request.providerInstanceId,
      ) => {
        const selected = selectedRecord(request, "source");
        if (!selected) return undefined;
        return publish(
          accountForLaunch(providerInstanceId),
          selected.record.source,
          selected.record,
        );
      },
      restoreLaunch: (request: ClaudeStateBindingRestore) => {
        const selected = selectedRecord(request);
        if (!selected) return undefined;
        assertLaunch(selected.record);
        return accessFor(selected.reference, selected.record);
      },
      restoreStop: (request: ClaudeStateBindingRestore) => {
        const selected = selectedRecord(request, "ownership");
        return selected ? accessFor(selected.reference, selected.record, true) : undefined;
      },
    };
  });

/** New non-conversation entry points use the same server-issued binding path. */
export const makeClaudeStateBindingSelection = (input: {
  readonly stateDir?: string;
  readonly readSettings: () => ServerSettings;
}) =>
  Effect.gen(function* () {
    const secretStore = Option.getOrUndefined(yield* Effect.serviceOption(ServerSecretStore));
    let access:
      | Promise<Effect.Success<ReturnType<typeof makeClaudeStateBindingAccess>>>
      | undefined;
    return async (
      instanceId: string,
      options: ProviderStartOptions | undefined,
    ): Promise<ProviderStartOptions | undefined> => {
      const settings = input.readSettings();
      const instance = resolveProviderInstance(settings, { instanceId });
      if (
        instance?.driver !== "claudeAgent" ||
        !settings.providers.claudeAgent.shareStateAcrossAccounts
      )
        return options;
      if (!input.stateDir || !secretStore)
        throw new Error("Claude 共享历史需要完整的 Moss 服务器配置，请重启 Moss 后重试。");
      access ??= Effect.runPromise(
        makeClaudeStateBindingAccess({
          stateDir: input.stateDir,
          readAccount: (id) => claudeStateBindingAccountFromSettings(input.readSettings(), id),
        }).pipe(Effect.provideService(ServerSecretStore, secretStore)),
      ).catch((error) => {
        access = undefined;
        throw error;
      });
      const selected = await (await access).register(instanceId);
      return { ...options, claudeAgent: { ...options?.claudeAgent, ...selected.options } };
    };
  });
