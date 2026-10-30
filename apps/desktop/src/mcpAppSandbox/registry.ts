// FILE: registry.ts
// Purpose: In-memory authority for one isolated MCP App guest generation.
// Layer: Electron main-process support (no HTML or native ports are stored).

import * as Crypto from "node:crypto";

import {
  MCP_APP_SANDBOX_PENDING_TTL_MS,
  MCP_APP_SANDBOX_SCHEME,
  decodeMcpAppSandboxRegisterInput,
  decodeMcpAppSandboxUnregisterInput,
  type McpAppSandboxDescriptor,
  type McpAppSandboxRegisterInput,
} from "@synara/contracts";

const MAX_AUTHORITIES = 256;

function canonicalDomainList(domains: readonly string[]): string[] {
  return [...new Set(domains)].toSorted();
}

export interface McpAppSandboxRegistryOptions {
  readonly now?: () => number;
  readonly createInitId?: () => string;
}

export interface McpAppSandboxOwner {
  readonly ownerId: number;
}

export interface McpAppSandboxAttachmentRequest {
  readonly ownerId: number;
  readonly sandboxId: string;
  readonly initId: string;
  readonly generation: number;
  readonly partition: string;
  readonly src: string;
  readonly origin: string;
}

export interface McpAppSandboxRegistration {
  readonly ownerId: number;
  readonly input: McpAppSandboxRegisterInput;
  readonly descriptor: McpAppSandboxDescriptor;
  readonly expiresAt: number;
  readonly sourceKey: string;
  readonly authorityKey: string;
  readonly cardIdentityKey: string;
  readonly cspFingerprint: string;
}

export interface McpAppSandboxLookupOptions {
  readonly ownerId?: number;
  readonly partition?: string;
}

function normalizedWidgetDomain(value: string | null | undefined): string {
  if (!value) return "";
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//iu.test(value) ? value : `https://${value}`;
  try {
    const parsed = new URL(candidate);
    return `${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ""}`;
  } catch {
    return value.trim().toLowerCase();
  }
}

function sourceKeyFor(input: McpAppSandboxRegisterInput): string {
  return [
    input.server,
    input.connectorId ?? "",
    input.resourceUri,
    normalizedWidgetDomain(input.widgetDomain),
  ].join("\u001f");
}

function sourceSandboxId(sourceKey: string): string {
  return `mcp-${Crypto.createHash("sha256").update(sourceKey, "utf8").digest("hex").slice(0, 40)}`;
}

function authorityKeyFor(
  ownerId: number,
  descriptor: Pick<McpAppSandboxDescriptor, "sandboxId" | "initId" | "generation">,
): string {
  return [ownerId, descriptor.sandboxId, descriptor.initId, descriptor.generation].join("\u001f");
}

function cardIdentityKeyFor(ownerId: number, input: McpAppSandboxRegisterInput): string {
  return [ownerId, input.threadId, input.callId, input.resourceUri].join("\u001f");
}

function cspFingerprintFor(input: McpAppSandboxRegisterInput): string {
  const csp = input.csp;
  return JSON.stringify({
    baseUriDomains: canonicalDomainList(csp.baseUriDomains),
    connectDomains: canonicalDomainList(csp.connectDomains),
    frameDomains: canonicalDomainList(csp.frameDomains),
    resourceDomains: canonicalDomainList(csp.resourceDomains),
  });
}

function defaultInitId(): string {
  return `init-${Crypto.randomUUID().replaceAll("-", "").slice(0, 40)}`;
}

function sanitizeInitId(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 200 ? trimmed.slice(0, 200) : trimmed;
}

function buildDescriptor(
  input: McpAppSandboxRegisterInput,
  sandboxId: string,
  partition: string,
  initId: string,
): McpAppSandboxDescriptor {
  const encodedInitId = encodeURIComponent(initId);
  const encodedGeneration = encodeURIComponent(String(input.generation));
  const origin = `${MCP_APP_SANDBOX_SCHEME}://${sandboxId}`;
  return {
    generation: input.generation,
    initId,
    origin,
    partition,
    sandboxId,
    src: `${origin}/ui?generation=${encodedGeneration}#init=${encodedInitId}`,
  };
}

export class McpAppSandboxRegistry {
  private readonly now: () => number;
  private readonly createInitId: () => string;
  private readonly pending = new Map<string, McpAppSandboxRegistration>();
  private readonly attached = new Map<string, McpAppSandboxRegistration>();

  constructor(options: McpAppSandboxRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.createInitId = options.createInitId ?? defaultInitId;
  }

  register(ownerId: number, rawInput: unknown): McpAppSandboxDescriptor {
    if (!Number.isSafeInteger(ownerId) || ownerId < 1) {
      throw new Error("Invalid MCP App owner.");
    }
    const input = decodeMcpAppSandboxRegisterInput(rawInput);
    if (!input) throw new Error("Invalid MCP App registration.");
    this.expire();

    if (this.pending.size + this.attached.size >= MAX_AUTHORITIES) {
      throw new Error("MCP App authority limit reached.");
    }

    const sourceKey = sourceKeyFor(input);
    const sandboxId = sourceSandboxId(sourceKey);
    // The partition is a pure deterministic source identity, not a cache. A
    // source that has fully torn down can be opened again without consuming a
    // process-lifetime slot; only live authorities are bounded below.
    const partition = `moss-mcp-${sandboxId}`;

    const initId = sanitizeInitId(this.createInitId());
    if (initId.length === 0) throw new Error("Invalid MCP App init authority.");
    const descriptor = buildDescriptor(input, sandboxId, partition, initId);
    const authorityKey = authorityKeyFor(ownerId, descriptor);
    const registration: McpAppSandboxRegistration = {
      ownerId,
      input,
      descriptor,
      expiresAt: this.now() + MCP_APP_SANDBOX_PENDING_TTL_MS,
      sourceKey,
      authorityKey,
      cardIdentityKey: cardIdentityKeyFor(ownerId, input),
      cspFingerprint: cspFingerprintFor(input),
    };
    this.pending.set(authorityKey, registration);
    return descriptor;
  }

  consumeAttachment(rawRequest: McpAppSandboxAttachmentRequest): McpAppSandboxRegistration | null {
    this.expire();
    const requestAuthorityKey = [
      rawRequest.ownerId,
      rawRequest.sandboxId,
      rawRequest.initId,
      rawRequest.generation,
    ].join("\u001f");
    const registration = this.pending.get(requestAuthorityKey);
    if (!registration || registration.ownerId !== rawRequest.ownerId) return null;
    const { descriptor } = registration;
    if (
      descriptor.initId !== rawRequest.initId ||
      descriptor.generation !== rawRequest.generation ||
      descriptor.partition !== rawRequest.partition ||
      descriptor.src !== rawRequest.src ||
      descriptor.origin !== rawRequest.origin
    ) {
      return null;
    }
    this.pending.delete(requestAuthorityKey);
    this.attached.set(registration.authorityKey, registration);
    return registration;
  }

  lookupByUrl(
    url: string,
    options: McpAppSandboxLookupOptions = {},
  ): McpAppSandboxRegistration | null {
    this.expire();
    const hasFragment = url.includes("#");
    const requestBase = hasFragment ? url.slice(0, url.indexOf("#")) : url;
    const candidates = [...this.pending.values(), ...this.attached.values()].filter(
      (registration) => {
        const descriptorUrl = registration.descriptor.src;
        if (options.ownerId !== undefined && registration.ownerId !== options.ownerId) return false;
        if (
          options.partition !== undefined &&
          registration.descriptor.partition !== options.partition
        ) {
          return false;
        }
        return hasFragment ? descriptorUrl === url : descriptorUrl.split("#", 1)[0] === requestBase;
      },
    );
    if (candidates.length === 0) return null;
    const first = candidates[0];
    if (!first) return null;
    if (hasFragment) return candidates.length === 1 ? first : null;
    // Electron protocol requests may omit the fragment. A shared source
    // partition can safely answer that route only when every matching
    // authority has the same normalized policy. Never select a wider CSP.
    const fingerprint = first.cspFingerprint;
    return candidates.every((candidate) => candidate.cspFingerprint === fingerprint) ? first : null;
  }

  releaseAttachment(ownerId: number, rawInput: unknown): boolean {
    const input = decodeMcpAppSandboxUnregisterInput(rawInput);
    if (!input) return false;
    for (const [authorityKey, registration] of this.attached) {
      const descriptor = registration.descriptor;
      if (
        registration.ownerId === ownerId &&
        descriptor.sandboxId === input.sandboxId &&
        descriptor.initId === input.initId &&
        descriptor.generation === input.generation
      ) {
        this.attached.delete(authorityKey);
        return true;
      }
    }
    return false;
  }

  unregister(ownerId: number, rawInput: unknown): boolean {
    const input = decodeMcpAppSandboxUnregisterInput(rawInput);
    if (!input) return false;
    const authorityKey = [ownerId, input.sandboxId, input.initId, input.generation].join("\u001f");
    const registration = this.pending.get(authorityKey);
    if (
      !registration ||
      registration.ownerId !== ownerId ||
      registration.descriptor.initId !== input.initId ||
      registration.descriptor.generation !== input.generation
    ) {
      return false;
    }
    this.pending.delete(authorityKey);
    return true;
  }

  /** Remove only one owner's older pending authority for one durable card. */
  replacePendingForOwnerCard(
    ownerId: number,
    cardIdentityKey: string,
    exceptAuthorityKey: string,
  ): number {
    let removed = 0;
    for (const [authorityKey, registration] of this.pending) {
      if (
        authorityKey !== exceptAuthorityKey &&
        registration.ownerId === ownerId &&
        registration.cardIdentityKey === cardIdentityKey
      ) {
        this.pending.delete(authorityKey);
        removed += 1;
      }
    }
    return removed;
  }

  teardownOwner(ownerId: number): number {
    let removed = 0;
    for (const [authorityKey, registration] of this.pending) {
      if (registration.ownerId === ownerId) {
        this.pending.delete(authorityKey);
        removed += 1;
      }
    }
    for (const [authorityKey, registration] of this.attached) {
      if (registration.ownerId === ownerId) {
        this.attached.delete(authorityKey);
        removed += 1;
      }
    }
    return removed;
  }

  teardownSandbox(sandboxId: string): boolean {
    let removed = false;
    for (const [authorityKey, registration] of this.pending) {
      if (registration.descriptor.sandboxId !== sandboxId) continue;
      this.pending.delete(authorityKey);
      removed = true;
    }
    for (const [authorityKey, registration] of this.attached) {
      if (registration.descriptor.sandboxId === sandboxId) {
        this.attached.delete(authorityKey);
        removed = true;
      }
    }
    return removed;
  }

  hasPartition(partition: string): boolean {
    this.expire();
    return [...this.pending.values(), ...this.attached.values()].some(
      (registration) => registration.descriptor.partition === partition,
    );
  }

  expire(): number {
    const currentTime = this.now();
    let removed = 0;
    for (const [authorityKey, registration] of this.pending) {
      if (registration.expiresAt <= currentTime) {
        this.pending.delete(authorityKey);
        removed += 1;
      }
    }
    return removed;
  }

  hasPending(sandboxId: string): boolean {
    this.expire();
    return [...this.pending.values()].some(
      (registration) => registration.descriptor.sandboxId === sandboxId,
    );
  }

  get pendingCount(): number {
    this.expire();
    return this.pending.size;
  }
}

export {
  authorityKeyFor,
  cardIdentityKeyFor,
  cspFingerprintFor,
  normalizedWidgetDomain,
  sourceKeyFor,
  sourceSandboxId,
};
