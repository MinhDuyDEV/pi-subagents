import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { withFileLock } from "./file-lock.js";

const STORE_VERSION = 1;
const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1_000;

export type ResourceClaimKind = "write" | "test" | "evidence";
export type ResourceClaimMode = "shared" | "exclusive";

export interface ResourceClaim {
  kind: ResourceClaimKind;
  resource: string;
  mode: ResourceClaimMode;
}

export interface ResourceLease {
  id: string;
  owner: string;
  claims: ResourceClaim[];
  acquiredAt: string;
  heartbeatAt?: string;
  expiresAt: string;
}

interface ResourceLeaseStore {
  version: number;
  leases: ResourceLease[];
}

export interface AcquireResourceLeaseInput {
  storePath: string;
  owner: string;
  claims: readonly ResourceClaim[];
  now?: Date;
  ttlMs?: number;
}

export interface ListResourceLeasesInput {
  storePath: string;
  now?: Date;
}

export interface ReleaseResourceLeaseInput {
  storePath: string;
  leaseId: string;
  now?: Date;
}

export interface TransferResourceLeaseOwnershipInput {
  storePath: string;
  leaseId: string;
  owner: string;
  now?: Date;
}

export interface RenewResourceLeaseInput {
  storePath: string;
  leaseId: string;
  owner: string;
  ttlMs?: number;
  now?: Date;
}

export class ResourceClaimConflictError extends Error {
  readonly owner: string;
  readonly resource: string;
  readonly conflictingResource: string;
  readonly kind: ResourceClaimKind;

  constructor(input: {
    owner: string;
    resource: string;
    conflictingResource: string;
    kind: ResourceClaimKind;
  }) {
    super(
      `${input.kind} resource ${JSON.stringify(input.resource)} conflicts with ${JSON.stringify(input.conflictingResource)} owned by ${input.owner}`,
    );
    this.name = "ResourceClaimConflictError";
    this.owner = input.owner;
    this.resource = input.resource;
    this.conflictingResource = input.conflictingResource;
    this.kind = input.kind;
  }
}

export async function acquireResourceLease(
  input: AcquireResourceLeaseInput,
): Promise<ResourceLease> {
  if (!input.owner.trim()) {
    throw new Error("Resource lease owner must not be empty");
  }
  if (input.claims.length === 0) {
    throw new Error("Resource lease requires at least one claim");
  }

  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error("Resource lease ttlMs must be greater than zero");
  }

  return withStoreLock(input.storePath, async () => {
    const store = await readStore(input.storePath);
    store.leases = activeLeases(store.leases, now);
    const claims = input.claims.map(normalizeClaim);

    for (const lease of store.leases) {
      if (lease.owner === input.owner) {
        continue;
      }
      for (const requested of claims) {
        for (const existing of lease.claims) {
          if (claimsConflict(requested, existing)) {
            throw new ResourceClaimConflictError({
              owner: lease.owner,
              resource: requested.resource,
              conflictingResource: existing.resource,
              kind: requested.kind,
            });
          }
        }
      }
    }

    const lease: ResourceLease = {
      id: randomUUID(),
      owner: input.owner,
      claims,
      acquiredAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    };
    store.leases.push(lease);
    await writeStore(input.storePath, store);
    return lease;
  });
}

export async function listActiveResourceLeases(
  input: ListResourceLeasesInput,
): Promise<ResourceLease[]> {
  const now = input.now ?? new Date();
  return withStoreLock(input.storePath, async () => {
    const store = await readStore(input.storePath);
    const leases = activeLeases(store.leases, now);
    if (leases.length !== store.leases.length) {
      store.leases = leases;
      await writeStore(input.storePath, store);
    }
    return leases;
  });
}

export async function transferResourceLeaseOwnership(
  input: TransferResourceLeaseOwnershipInput,
): Promise<ResourceLease | undefined> {
  if (!input.owner.trim()) {
    throw new Error("Resource lease owner must not be empty");
  }
  const now = input.now ?? new Date();
  return withStoreLock(input.storePath, async () => {
    const store = await readStore(input.storePath);
    store.leases = activeLeases(store.leases, now);
    const lease = store.leases.find((candidate) => candidate.id === input.leaseId);
    if (!lease) {
      await writeStore(input.storePath, store);
      return undefined;
    }
    lease.owner = input.owner;
    lease.heartbeatAt = now.toISOString();
    await writeStore(input.storePath, store);
    return lease;
  });
}

export async function renewResourceLease(
  input: RenewResourceLeaseInput,
): Promise<ResourceLease | undefined> {
  if (!input.owner.trim()) {
    throw new Error("Resource lease owner must not be empty");
  }
  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error("Resource lease ttlMs must be greater than zero");
  }
  return withStoreLock(input.storePath, async () => {
    const store = await readStore(input.storePath);
    store.leases = activeLeases(store.leases, now);
    const lease = store.leases.find((candidate) => candidate.id === input.leaseId);
    if (!lease) {
      await writeStore(input.storePath, store);
      return undefined;
    }
    if (lease.owner !== input.owner) {
      throw new Error(
        `Resource lease ${input.leaseId} is owned by ${lease.owner}, not ${input.owner}`,
      );
    }
    lease.heartbeatAt = now.toISOString();
    lease.expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    await writeStore(input.storePath, store);
    return { ...lease, claims: lease.claims.map((claim) => ({ ...claim })) };
  });
}

export async function releaseResourceLease(
  input: ReleaseResourceLeaseInput,
): Promise<boolean> {
  const now = input.now ?? new Date();
  return withStoreLock(input.storePath, async () => {
    const store = await readStore(input.storePath);
    const current = activeLeases(store.leases, now);
    const remaining = current.filter((lease) => lease.id !== input.leaseId);
    const released = remaining.length !== current.length;
    store.leases = remaining;
    await writeStore(input.storePath, store);
    return released;
  });
}

export interface ReleaseOrphanedLeasesInput {
  storePath: string;
  aliveOwnerIds: ReadonlySet<string>;
  now?: Date;
}

/** Release active leases whose owner is no longer an alive task (Herdr §16.3 — handle
 * abandoned locks on crash/freeze/compact, don't wait for TTL expiry). Returns the
 * reaped lease ids. */
export async function releaseOrphanedLeases(
  input: ReleaseOrphanedLeasesInput,
): Promise<string[]> {
  const now = input.now ?? new Date();
  const active = await listActiveResourceLeases({ storePath: input.storePath, now });
  const reaped: string[] = [];
  for (const lease of active) {
    if (input.aliveOwnerIds.has(lease.owner)) continue;
    await releaseResourceLease({ storePath: input.storePath, leaseId: lease.id, now });
    reaped.push(lease.id);
  }
  return reaped;
}

export function claimCoversPath(resource: string, path: string): boolean {
  const parent = staticGlobPrefix(normalizeResource(resource));
  const child = normalizeResource(path);
  return pathContains(parent, child);
}

export function leaseCoversPath(lease: ResourceLease, path: string): boolean {
  return lease.claims.some(
    (claim) =>
      (claim.kind === "write" || claim.kind === "test") &&
      claimCoversPath(claim.resource, path),
  );
}

export interface FindClaimCoveringPathInput {
  storePath: string;
  path: string;
  now?: Date;
}

export async function findClaimCoveringPath(
  input: FindClaimCoveringPathInput,
): Promise<ResourceLease | undefined> {
  const now = input.now ?? new Date();
  const leases = await listActiveResourceLeases({
    storePath: input.storePath,
    now,
  });
  return leases.find((lease) => leaseCoversPath(lease, input.path));
}

export interface AssertNoConflictingWriteInput {
  storePath: string;
  ownerTaskId: string;
  path: string;
  now?: Date;
}

export async function assertNoConflictingWrite(
  input: AssertNoConflictingWriteInput,
): Promise<void> {
  const lease = await findClaimCoveringPath({
    storePath: input.storePath,
    path: input.path,
    now: input.now,
  });
  if (!lease || lease.owner === input.ownerTaskId) {
    return;
  }
  const claim = lease.claims.find(
    (item) =>
      (item.kind === "write" || item.kind === "test") &&
      claimCoversPath(item.resource, input.path),
  );
  throw new Error(
    `Write blocked: ${input.path} is locked by task ${lease.owner} (${claim?.mode ?? "exclusive"} ${claim?.kind ?? "write"} claim)`,
  );
}

export function claimsConflict(
  left: ResourceClaim,
  right: ResourceClaim,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.mode === "shared" && right.mode === "shared") {
    return false;
  }

  if (left.kind === "test") {
    return wildcardResourcesOverlap(left.resource, right.resource);
  }
  return pathResourcesOverlap(left.resource, right.resource);
}

function normalizeClaim(claim: ResourceClaim): ResourceClaim {
  const resource = normalizeResource(claim.resource);
  if (!resource) {
    throw new Error("Resource claim must not be empty");
  }
  if (claim.kind === "write") {
    if (claim.mode !== "exclusive") {
      throw new Error("Write resource claims must be exclusive");
    }
    if (
      resource === ".." ||
      resource.startsWith("../") ||
      resource.includes("/../") ||
      isAbsolute(resource) ||
      /^[A-Za-z]:\//u.test(resource) ||
      resource.startsWith("//")
    ) {
      throw new Error(`Write resource claim must stay inside the project: ${claim.resource}`);
    }
  }
  return { ...claim, resource };
}

function normalizeResource(resource: string): string {
  return resource
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .replace(/\/{2,}/gu, "/")
    .replace(/\/$/u, "");
}

function pathResourcesOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizeResource(left);
  const normalizedRight = normalizeResource(right);
  if (normalizedLeft === normalizedRight) {
    return true;
  }

  const leftPrefix = staticGlobPrefix(normalizedLeft);
  const rightPrefix = staticGlobPrefix(normalizedRight);
  return pathContains(leftPrefix, rightPrefix) || pathContains(rightPrefix, leftPrefix);
}

function wildcardResourcesOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizeResource(left);
  const normalizedRight = normalizeResource(right);
  if (normalizedLeft === normalizedRight || normalizedLeft === "*" || normalizedRight === "*") {
    return true;
  }
  const leftPrefix = staticGlobPrefix(normalizedLeft);
  const rightPrefix = staticGlobPrefix(normalizedRight);
  return (
    leftPrefix === "" ||
    rightPrefix === "" ||
    leftPrefix.startsWith(rightPrefix) ||
    rightPrefix.startsWith(leftPrefix)
  );
}

function staticGlobPrefix(resource: string): string {
  const wildcardIndex = resource.search(/[?*[\]{}]/u);
  if (wildcardIndex === -1) {
    return resource;
  }
  return resource.slice(0, wildcardIndex).replace(/\/$/u, "");
}

function pathContains(parent: string, child: string): boolean {
  return parent === "" || child === parent || child.startsWith(`${parent}/`);
}

function activeLeases(leases: readonly ResourceLease[], now: Date): ResourceLease[] {
  const timestamp = now.getTime();
  return leases.filter((lease) => Date.parse(lease.expiresAt) > timestamp);
}

async function readStore(storePath: string): Promise<ResourceLeaseStore> {
  try {
    const value: unknown = JSON.parse(await readFile(storePath, "utf8"));
    if (!isResourceLeaseStore(value)) {
      throw new Error(`Invalid resource lease store: ${storePath}`);
    }
    return value;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { version: STORE_VERSION, leases: [] };
    }
    throw error;
  }
}

async function writeStore(
  storePath: string,
  store: ResourceLeaseStore,
): Promise<void> {
  await mkdir(dirname(storePath), { recursive: true });
  const temporaryPath = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(temporaryPath, storePath);
}

async function withStoreLock<T>(
  storePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withFileLock({ lockPath: `${storePath}.lock`, operation });
}

function isResourceLeaseStore(value: unknown): value is ResourceLeaseStore {
  if (!isRecord(value) || value.version !== STORE_VERSION || !Array.isArray(value.leases)) {
    return false;
  }
  return value.leases.every(isResourceLease);
}

function isResourceLease(value: unknown): value is ResourceLease {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.owner === "string" &&
    typeof value.acquiredAt === "string" &&
    typeof value.expiresAt === "string" &&
    Array.isArray(value.claims) &&
    value.claims.every(isResourceClaim)
  );
}

function isResourceClaim(value: unknown): value is ResourceClaim {
  return (
    isRecord(value) &&
    (value.kind === "write" || value.kind === "test" || value.kind === "evidence") &&
    (value.mode === "shared" || value.mode === "exclusive") &&
    typeof value.resource === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
