import { createHmac } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";

import { Effect, Option } from "effect";
import type { ProviderStartOptions, ServerSettings } from "@moss/contracts";
import {
  providerStartOptionsFromInstance,
  resolveProviderInstance,
} from "@moss/shared/providerInstances";

import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { readManagedCodexHomeAuthority } from "../account/mossManagedHomeAuthority.ts";
import {
  issueCodexCredentialFence,
  readCodexCredentialFence,
  type CodexCredentialFence,
  type CodexCredentialScopeInput,
} from "../codexHomeIdentity.ts";
import {
  prepareCodexHomeOverlay,
  prepareCodexHomeOverlayFromPreparedContinuationSource,
  readPreparedSharedCodexContinuationGeneration,
  prepareCodexAuthTracking,
  readCodexPreparedAuthTrackingFingerprint,
} from "../codexProcessEnv.ts";
import {
  agentStateDirectoryIdentity,
  assertAgentStateDirectoryCurrent,
  makeAgentStateBindingRecords,
  sameAgentStateDirectory as sameDirectory,
  type AgentStateDirectoryIdentity as DirectoryIdentity,
} from "./agentStateBindingRecords.ts";

const BINDING_KEY = "codex-state-bindings-hmac-v1";
const issuedReferences = new WeakMap<CodexCredentialFence, string>();

/** Only a live server capability can contribute a durable reference. */
export function codexStateBindingReference(
  input: CodexCredentialScopeInput | undefined,
): string | undefined {
  const fence = readCodexCredentialFence(input);
  return fence ? issuedReferences.get(fence) : undefined;
}

export interface CodexStateBindingOwner {
  readonly providerInstanceId: string;
  readonly accountId: string;
}

/** The caller reads this from current server settings, never a client snapshot. */
export interface CodexStateBindingAccount extends CodexStateBindingOwner {
  readonly enabled: boolean;
  readonly sourceHomePath: string;
  readonly privateHomePath: string;
  readonly runtimeGeneration?: string;
}

/** Uses explicit server settings only; an empty private home never means ambient HOME. */
export function codexStateBindingAccountFromSettings(
  settings: ServerSettings,
  providerInstanceId: string,
): CodexStateBindingAccount | undefined {
  const instance = resolveProviderInstance(settings, {
    instanceId: providerInstanceId,
    provider: "codex",
  });
  if (!instance) return undefined;
  const options = providerStartOptionsFromInstance(instance)?.codex;
  const sourceHomePath = settings.providers.codex.homePath.trim();
  const configuredHome = options?.homePath?.trim() ?? "";
  // Keep an explicitly selected private home independent of later global
  // source changes. Registration separately rejects equal/nested roots.
  const privateHomePath = options?.shadowHomePath?.trim() || configuredHome;
  return {
    providerInstanceId: instance.instanceId,
    accountId: options?.accountId?.trim() || instance.instanceId,
    enabled: instance.enabled && settings.providers.codex.enabled,
    sourceHomePath,
    privateHomePath,
    ...(options?.runtimeGeneration ? { runtimeGeneration: options.runtimeGeneration } : {}),
  };
}

interface BindingRecord extends CodexStateBindingOwner {
  readonly version: 1;
  readonly provider: "codex";
  readonly server: DirectoryIdentity;
  readonly source: DirectoryIdentity;
  readonly private: DirectoryIdentity;
  readonly sourceGeneration: string;
  readonly runtimeGeneration: string;
}

export interface CodexStateBindingAccess {
  readonly reference: string;
  readonly sourceGeneration: string;
  readonly options: CodexCredentialScopeInput & {
    readonly homePath: string;
    readonly shadowHomePath: string;
    readonly accountId: string;
    readonly runtimeGeneration: string;
  };
}

export interface CodexStateBindingRestore extends CodexStateBindingOwner {
  readonly reference?: string;
  /** Taken from the thread's existing durable binding, not its incoming request. */
  readonly expectedReference?: string;
}

function directoryIdentity(directory: string): DirectoryIdentity {
  return agentStateDirectoryIdentity(directory, "Codex");
}

function assertDirectoryCurrent(identity: DirectoryIdentity): void {
  assertAgentStateDirectoryCurrent(identity, "Codex");
}

function assertOwner(record: CodexStateBindingOwner, expected: CodexStateBindingOwner): void {
  if (
    record.providerInstanceId !== expected.providerInstanceId ||
    record.accountId !== expected.accountId
  ) {
    throw new Error("Codex 历史绑定不属于所选账户，请重新选择原账户。");
  }
}

/**
 * A small persistent receipt helper, not a new service or lock. Existing home
 * identity helpers cannot restore signed, previously selected sources; the
 * managed-home authority intentionally covers only its fixed Windows home.
 */
export const makeCodexStateBindingAccess = (input: {
  readonly stateDir: string;
  readonly runtimeHomePath: string;
  readonly readAccount: (providerInstanceId: string) => CodexStateBindingAccount | undefined;
}) =>
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore;
    const key = yield* secrets.getOrCreateRandom(BINDING_KEY, 32);
    const server = directoryIdentity(input.stateDir);
    const records = makeAgentStateBindingRecords<BindingRecord>({
      provider: "codex",
      key,
      server,
      label: "Codex",
    });
    const readRecord = (
      reference: string,
      expected: CodexStateBindingOwner,
      requirePrivate = true,
    ): BindingRecord => {
      const record = records.read(reference);
      assertOwner(record, expected);
      assertDirectoryCurrent(record.source);
      if (requirePrivate) assertDirectoryCurrent(record.private);
      if (
        readPreparedSharedCodexContinuationGeneration(record.source.path) !==
        record.sourceGeneration
      ) {
        throw new Error("Codex 历史来源已更换，请保留原历史目录后重试。");
      }
      return record;
    };
    const accountForLaunch = async (
      owner: CodexStateBindingOwner,
    ): Promise<CodexStateBindingAccount & { readonly runtimeGeneration: string }> => {
      const account = input.readAccount(owner.providerInstanceId);
      if (!account) throw new Error("Codex 账户已移除，请重新选择账户。");
      assertOwner(account, owner);
      if (!account.enabled) throw new Error("Codex 账户已停用，请启用账户后重试。");
      if (account.runtimeGeneration?.trim())
        return account as CodexStateBindingAccount & { runtimeGeneration: string };
      if (account.accountId === "moss" || account.accountId === "byok") {
        throw new Error("Codex 账户代际无效，请重新连接账户。");
      }
      const privateHome = directoryIdentity(account.privateHomePath);
      const authPath = path.join(privateHome.path, "auth.json");
      const authRevision = async () => {
        try {
          const stat = await lstat(authPath, { bigint: true });
          return JSON.stringify([
            String(stat.dev),
            String(stat.ino),
            String(stat.mtimeNs),
            String(stat.ctimeNs),
            String(stat.size),
          ]);
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
            return "missing";
          throw error;
        }
      };
      const before = await authRevision();
      const fingerprint = readCodexPreparedAuthTrackingFingerprint(
        prepareCodexAuthTracking({
          homePath: privateHome.path,
          accountId: account.accountId,
          env: { MOSS_HOME: input.runtimeHomePath },
        }),
      );
      if ((await authRevision()) !== before)
        throw new Error("Codex 认证在读取时发生变化，请重试。");
      const current = input.readAccount(owner.providerInstanceId);
      if (
        !current?.enabled ||
        current.providerInstanceId !== owner.providerInstanceId ||
        current.accountId !== owner.accountId ||
        current.privateHomePath !== account.privateHomePath ||
        current.runtimeGeneration !== account.runtimeGeneration
      ) {
        throw new Error("Codex 账户设置在读取认证时发生变化，请重试。");
      }
      assertDirectoryCurrent(privateHome);
      // File revision distinguishes re-login with the same credentials from the
      // generation tombstoned by logout. No credential fingerprint is persisted.
      const runtimeGeneration = createHmac("sha256", key)
        .update("account-generation\n")
        .update(
          JSON.stringify([
            owner.providerInstanceId,
            owner.accountId,
            privateHome,
            before,
            fingerprint,
          ]),
        )
        .digest("hex");
      return { ...account, runtimeGeneration };
    };
    const accessFor = (reference: string, record: BindingRecord): CodexStateBindingAccess => {
      const options = {
        homePath: record.source.path,
        shadowHomePath: record.private.path,
        accountId: record.accountId,
        runtimeGeneration: record.runtimeGeneration,
        environment: { MOSS_HOME: input.runtimeHomePath },
      };
      const credentialFence = issueCodexCredentialFence({
        ...options,
        // Ownership remains valid after disable/generation rotation, so teardown
        // can still drain old processes. Launch eligibility is checked separately.
        assertBindingCurrent: () => {
          readRecord(reference, record);
        },
      });
      issuedReferences.set(credentialFence, reference);
      return {
        reference,
        sourceGeneration: record.sourceGeneration,
        options: { ...options, credentialFence },
      };
    };
    const requestedRecord = (request: CodexStateBindingRestore, requirePrivate = true) => {
      if (request.reference === undefined && request.expectedReference === undefined)
        return undefined;
      if (!request.reference || request.reference !== request.expectedReference) {
        throw new Error("Codex 历史绑定与当前对话不一致，请重新打开原对话。");
      }
      return {
        reference: request.reference,
        record: readRecord(request.reference, request, requirePrivate),
      };
    };
    const restoreLaunch = async (
      request: CodexStateBindingRestore,
    ): Promise<CodexStateBindingAccess | undefined> => {
      const selected = requestedRecord(request);
      if (!selected) return undefined;
      const { record, reference } = selected;
      const account = await accountForLaunch(request);
      const current = input.readAccount(request.providerInstanceId);
      if (
        !current?.enabled ||
        current.providerInstanceId !== account.providerInstanceId ||
        current.accountId !== account.accountId ||
        current.privateHomePath !== account.privateHomePath ||
        (current.runtimeGeneration?.trim() &&
          current.runtimeGeneration !== account.runtimeGeneration) ||
        account.runtimeGeneration !== record.runtimeGeneration ||
        !sameDirectory(record.private, directoryIdentity(account.privateHomePath))
      ) {
        throw new Error("Codex 账户绑定已更换，请重新连接账户并保留当前历史。");
      }
      // The current global source setting deliberately does not replace the
      // source of an already registered thread.
      return accessFor(reference, record);
    };
    const publish = async (record: BindingRecord): Promise<CodexStateBindingAccess> => {
      const reference = await records.publish(record);
      return (await restoreLaunch({ ...record, reference, expectedReference: reference }))!;
    };
    const renewTo = async (
      request: CodexStateBindingRestore,
      target: CodexStateBindingOwner,
    ): Promise<CodexStateBindingAccess | undefined> => {
      // The original owner/ref come from the stored thread. A different target
      // must be independently selected by the server, never inferred from a ref.
      const selected = requestedRecord(request, false);
      if (!selected) return undefined;
      const { record, reference } = selected;
      const account = await accountForLaunch(target);
      const privateHome = directoryIdentity(account.privateHomePath);
      const sameOwner =
        record.providerInstanceId === target.providerInstanceId &&
        record.accountId === target.accountId;
      if (privateHome.path === record.private.path) {
        assertDirectoryCurrent(record.private);
        if (!sameOwner)
          throw new Error("不同 Codex 账户不能共用认证目录，请为目标账户选择独立目录。");
        if (account.runtimeGeneration === record.runtimeGeneration)
          return accessFor(reference, record);
      }
      const options = {
        homePath: record.source.path,
        shadowHomePath: privateHome.path,
        accountId: account.accountId,
        runtimeGeneration: account.runtimeGeneration,
        environment: { MOSS_HOME: input.runtimeHomePath },
      };
      const credentialFence = issueCodexCredentialFence({
        ...options,
        assertBindingCurrent: () => {
          readRecord(reference, request, false);
          assertDirectoryCurrent(privateHome);
        },
      });
      await prepareCodexHomeOverlayFromPreparedContinuationSource({
        ...options,
        env: options.environment,
        credentialFence,
        expectedSharedContinuationGeneration: record.sourceGeneration,
      });
      const current = await accountForLaunch(target);
      if (
        current.runtimeGeneration !== account.runtimeGeneration ||
        !sameDirectory(privateHome, directoryIdentity(current.privateHomePath))
      ) {
        throw new Error("Codex 账户设置在续接时发生变化，请重试。");
      }
      return publish({
        ...record,
        providerInstanceId: target.providerInstanceId,
        accountId: target.accountId,
        private: privateHome,
        runtimeGeneration: account.runtimeGeneration,
      });
    };
    return {
      register: async (owner: CodexStateBindingOwner): Promise<CodexStateBindingAccess> => {
        const account = await accountForLaunch(owner);
        const source = directoryIdentity(account.sourceHomePath);
        const privateHome = directoryIdentity(account.privateHomePath);
        const options = {
          homePath: source.path,
          shadowHomePath: privateHome.path,
          accountId: account.accountId,
          runtimeGeneration: account.runtimeGeneration,
          environment: { MOSS_HOME: input.runtimeHomePath },
        };
        const credentialFence = issueCodexCredentialFence({
          ...options,
          assertBindingCurrent: () => {
            assertDirectoryCurrent(server);
            assertDirectoryCurrent(source);
            assertDirectoryCurrent(privateHome);
          },
        });
        // Bootstrap uses the existing continuation generation lock and creates
        // no process. The temporary capability never escapes registration.
        await prepareCodexHomeOverlay({ ...options, env: options.environment, credentialFence });
        const sourceGeneration = readPreparedSharedCodexContinuationGeneration(source.path);
        if (!sourceGeneration) throw new Error("Codex 历史目录尚未准备完成，请重试。");
        const current = await accountForLaunch(owner);
        if (
          current.runtimeGeneration !== account.runtimeGeneration ||
          !sameDirectory(source, directoryIdentity(current.sourceHomePath)) ||
          !sameDirectory(privateHome, directoryIdentity(current.privateHomePath))
        ) {
          throw new Error("Codex 账户设置在绑定时发生变化，请重试。");
        }
        const record: BindingRecord = {
          version: 1,
          provider: "codex",
          providerInstanceId: owner.providerInstanceId,
          accountId: owner.accountId,
          server,
          source,
          private: privateHome,
          sourceGeneration,
          runtimeGeneration: account.runtimeGeneration,
        };
        // Revalidate disk and current eligibility after publication as well.
        return publish(record);
      },
      renew: async (
        request: CodexStateBindingRestore,
      ): Promise<CodexStateBindingAccess | undefined> => {
        // A retired private directory may have been removed after its processes
        // drained. Its signed record still proves the old thread's source; it
        // does not authorize using that private directory again.
        return renewTo(request, request);
      },
      rebind: renewTo,
      restoreLaunch,
      restoreStop: (request: CodexStateBindingRestore) => {
        const selected = requestedRecord(request);
        return selected && accessFor(selected.reference, selected.record);
      },
    };
  });

/** New, non-conversation entry points share the same server receipt helper. */
export const makeCodexStateBindingSelection = (input: {
  readonly stateDir?: string;
  readonly runtimeHomePath?: string;
  readonly readSettings: () => ServerSettings;
}) =>
  Effect.gen(function* () {
    const secretStore = Option.getOrUndefined(yield* Effect.serviceOption(ServerSecretStore));
    let access: Promise<Effect.Success<ReturnType<typeof makeCodexStateBindingAccess>>> | undefined;
    return async (
      instanceId: string,
      options: ProviderStartOptions | undefined,
    ): Promise<ProviderStartOptions | undefined> => {
      const settings = input.readSettings();
      const instance = resolveProviderInstance(settings, { instanceId });
      if (instance?.driver !== "codex" || !settings.providers.codex.shareStateAcrossAccounts)
        return options;
      if (!input.stateDir || !input.runtimeHomePath || !secretStore) {
        throw new Error("Codex 共享历史需要完整的 Moss 服务器配置，请重启 Moss 后重试。");
      }
      const account = codexStateBindingAccountFromSettings(settings, instanceId);
      if (!account) throw new Error("Codex 账户已移除，请重新选择账户。");
      await readManagedCodexHomeAuthority({
        stateDir: input.stateDir,
        readSettings: async () => input.readSettings(),
        readSettingsSync: input.readSettings,
        input: {
          ...providerStartOptionsFromInstance(instance)?.codex,
          env: { ...process.env, ...instance.environment },
        },
      });
      access ??= Effect.runPromise(
        makeCodexStateBindingAccess({
          stateDir: input.stateDir,
          runtimeHomePath: input.runtimeHomePath,
          readAccount: (id) => codexStateBindingAccountFromSettings(input.readSettings(), id),
        }).pipe(Effect.provideService(ServerSecretStore, secretStore)),
      ).catch((error) => {
        access = undefined;
        throw error;
      });
      const selected = await (
        await access
      ).register({ providerInstanceId: instanceId, accountId: account.accountId });
      return {
        ...options,
        codex: {
          ...options?.codex,
          ...selected.options,
          environment: { ...options?.codex?.environment, ...selected.options.environment },
        },
      };
    };
  });
