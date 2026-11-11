// FILE: registry.ts
// Purpose: In-memory authority for one isolated MCP App guest generation.
// Layer: Electron main-process support (no HTML or native ports are stored).

import * as Crypto from "node:crypto";

import {
  MCP_APP_SANDBOX_PATH,
  MCP_APP_SANDBOX_PENDING_TTL_MS,
  MCP_APP_SANDBOX_SCHEME,
  decodeMcpAppSandboxRegisterInput,
  decodeMcpAppSandboxUnregisterInput,
  type McpAppSandboxDescriptor,
  type McpAppSandboxRegisterInput,
} from "@moss/contracts";

import { buildMcpAppSandboxPolicy, type McpAppSandboxEffectivePolicy } from "./csp";
import {
  isUsableMcpAppSandboxLabel,
  resolveMcpAppSandboxOrigin,
  type McpAppSandboxVariant,
} from "./origin";

const MAX_AUTHORITIES = 256;

function canonicalDomainList(domains: readonly string[]): string[] {
  return [...new Set(domains)].toSorted();
}

export interface McpAppSandboxRegistryOptions {
  readonly now?: () => number;
  readonly createInitId?: () => string;
  readonly createRouteId?: () => string;
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
  readonly variant: McpAppSandboxVariant;
  /** Effective network/permission policy; drives the response headers and webRequest. */
  readonly policy: McpAppSandboxEffectivePolicy;
}

export interface McpAppSandboxLookupOptions {
  readonly ownerId?: number;
  readonly partition?: string;
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

function cspFingerprintFor(
  policy: McpAppSandboxEffectivePolicy,
  variant: McpAppSandboxVariant,
): string {
  return JSON.stringify({
    connectDomains: canonicalDomainList(policy.connectDomains),
    frameDomains: canonicalDomainList(policy.frameDomains),
    permissions: Object.keys(policy.permissions).toSorted(),
    resourceDomains: canonicalDomainList(policy.resourceDomains),
    variant,
  });
}

function defaultInitId(): string {
  return `init-${Crypto.randomUUID().replaceAll("-", "").slice(0, 40)}`;
}

function defaultRouteId(): string {
  return Crypto.randomBytes(8).toString("hex");
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
  routeId: string,
): McpAppSandboxDescriptor {
  const encodedInitId = encodeURIComponent(initId);
  const encodedGeneration = encodeURIComponent(String(input.generation));
  const origin = `${MCP_APP_SANDBOX_SCHEME}://${sandboxId}`;
  // `route` keeps the fragment-less URL unique per registration: many cards of
  // one thread x server share the origin, and each gets its own policy.
  return {
    generation: input.generation,
    initId,
    origin,
    partition,
    sandboxId,
    src: `${origin}${MCP_APP_SANDBOX_PATH}?generation=${encodedGeneration}&route=${routeId}#init=${encodedInitId}`,
  };
}

export class McpAppSandboxRegistry {
  private readonly now: () => number;
  private readonly createInitId: () => string;
  private readonly createRouteId: () => string;
  private readonly pending = new Map<string, McpAppSandboxRegistration>();
  private readonly attached = new Map<string, McpAppSandboxRegistration>();

  constructor(options: McpAppSandboxRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.createInitId = options.createInitId ?? defaultInitId;
    this.createRouteId = options.createRouteId ?? defaultRouteId;
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

    const policy = buildMcpAppSandboxPolicy(input.csp, input.permissions ?? {});
    if (!policy) throw new Error("Invalid MCP App policy.");
    const { label, variant } = resolveMcpAppSandboxOrigin(input);
    if (!isUsableMcpAppSandboxLabel(label)) throw new Error("Unusable MCP App origin label.");
    const sandboxId = label;
    // One partition per origin label (thread x server, or connector URL for the
    // stable variant). It is a deterministic identity, not a cache; only live
    // authorities are bounded below.
    const partition = `moss-mcp-${sandboxId}`;

    const initId = sanitizeInitId(this.createInitId());
    if (initId.length === 0) throw new Error("Invalid MCP App init authority.");
    const routeId = this.createRouteId();
    if (!/^[0-9a-f]{16}$/u.test(routeId)) throw new Error("Invalid MCP App route.");
    const descriptor = buildDescriptor(input, sandboxId, partition, initId, routeId);
    const authorityKey = authorityKeyFor(ownerId, descriptor);
    const registration: McpAppSandboxRegistration = {
      ownerId,
      input,
      descriptor,
      expiresAt: this.now() + MCP_APP_SANDBOX_PENDING_TTL_MS,
      sourceKey: `${variant}:${label}`,
      authorityKey,
      cardIdentityKey: cardIdentityKeyFor(ownerId, input),
      cspFingerprint: cspFingerprintFor(policy, variant),
      variant,
      policy,
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

  /** Live registrations of one partition (pending or attached). */
  registrationsForPartition(partition: string): McpAppSandboxRegistration[] {
    this.expire();
    return [...this.pending.values(), ...this.attached.values()].filter(
      (registration) => registration.descriptor.partition === partition,
    );
  }
}

export { authorityKeyFor, cardIdentityKeyFor, cspFingerprintFor };
