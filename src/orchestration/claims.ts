/**
 * Resource leases with fencing tokens.
 *
 * A lease alone is not mutual exclusion. Expiry is decided by wall clock, so a
 * suspended laptop, a long GC pause, or a clock adjustment can let a lease
 * lapse while its holder still believes it owns the resource — and with the
 * default 30-minute TTL, closing a lid is enough. The holder only found out when
 * it tried to write, and only if someone else had already taken the resource.
 *
 * Every lease therefore carries a monotonically increasing {@link ResourceLease.fence}
 * drawn from the store. A writer presents the fence it was issued; a fence lower
 * than the one currently recorded for the covering lease means the writer's
 * lease was superseded, and the write is refused even though the owner id still
 * matches. That is the part expiry alone cannot express.
 */
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { withFileLock } from "./file-lock.js";

const STORE_VERSION = 2;
/** Store versions this build can read. Older ones are migrated forward on read. */
const SUPPORTED_STORE_VERSIONS = [1, 2] as const;
export const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1_000;

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
  /** Canonical execution root in which relative claim resources are interpreted. */
  scope?: string;
  claims: ResourceClaim[];
  acquiredAt: string;
  heartbeatAt?: string;
  expiresAt: string;
  /**
   * Monotonically increasing token, unique per store. Present it on every write;
   * a stale fence is refused even when the owner id still matches.
   */
  fence: number;
}

interface ResourceLeaseStore {
  version: number;
  /** Next fence to hand out. Never decreases, never reused. */
  nextFence: number;
  leases: ResourceLease[];
}

/**
 * Reporter for a store that had to be quarantined. Wired to the Pi event bus by
 * the runtime; a corrupt store used to throw on every subsequent operation, so
 * one bad claim bricked all writes until a human deleted the file by hand.
 */
export type StoreQuarantineReporter = (info: {
  storePath: string;
  quarantinePath: string;
  reason: string;
}) => void;

let reportQuarantine: StoreQuarantineReporter = () => undefined;

export function setStoreQuarantineReporter(reporter: StoreQuarantineReporter): void {
  reportQuarantine = reporter;
}

export interface AcquireResourceLeaseInput {
  storePath: string;
  owner: string;
  scope?: string;
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
  /**
   * The owner the caller believes holds the lease. Required: `release` used to
   * take only a lease id, so any caller could drop any other task's lease.
   * System-side reaping of dead owners goes through
   * {@link releaseOrphanedLeases}, which proves liveness instead of ownership.
   */
  expectedOwner: string;
  /** Exact lease generation held by the caller. */
  expectedFence: number;
  now?: Date;
}

export interface TransferResourceLeaseOwnershipInput {
  storePath: string;
  leaseId: string;
  owner: string;
  /** The owner the caller believes currently holds the lease. Required. */
  expectedOwner: string;
  /** Exact lease generation held by the caller. */
  expectedFence: number;
  now?: Date;
}

export interface RenewResourceLeaseInput {
  storePath: string;
  leaseId: string;
  owner: string;
  /** Exact lease generation held by the caller. */
  expectedFence: number;
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

  // Type-guard at the INPUT boundary, not just when reading the store back.
  // `parseOrchestrationRequest` used to bare-cast, so a claim like
  // `{kind:"bogus",mode:"wat"}` was written to disk and then made every
  // subsequent store read throw — one bad request bricked all writes.
  for (const claim of input.claims) {
    if (!isResourceClaim(claim)) {
      throw new Error(`Invalid resource claim: ${JSON.stringify(claim)}`);
    }
  }

  return withStoreLock(input.storePath, async () => {
    const store = await readStore(input.storePath);
    store.leases = activeLeases(store.leases, now);
    if (!hasAvailableFence(store.nextFence)) {
      throw new Error("Resource lease fence space is exhausted");
    }
    const claims = input.claims.map(normalizeClaim);

    for (const lease of store.leases) {
      if (!leaseScopesOverlap(input.scope, lease.scope)) continue;
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
      ...(input.scope ? { scope: input.scope } : {}),
      claims,
      acquiredAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      fence: store.nextFence,
    };
    store.nextFence += 1;
    store.leases.push(lease);
    await writeStore(input.storePath, store);
    return lease;
  });
}

/**
 * Active leases. A pure READ — it never rewrites the store.
 *
 * It used to prune expired leases and write them back, so every read was a
 * write: it took the lock, produced disk I/O on a hot path, and a read racing a
 * write could drop a lease another caller had just acquired. Pruning is now an
 * explicit operation ({@link pruneExpiredLeases}).
 */
export async function listActiveResourceLeases(
  input: ListResourceLeasesInput,
): Promise<ResourceLease[]> {
  const now = input.now ?? new Date();
  return withStoreLock(input.storePath, async () => {
    const store = await readStore(input.storePath);
    return activeLeases(store.leases, now);
  });
}

/** Drop expired leases from the store. Returns the ids removed. */
export async function pruneExpiredLeases(
  input: ListResourceLeasesInput,
): Promise<string[]> {
  const now = input.now ?? new Date();
  return withStoreLock(input.storePath, async () => {
    const store = await readStore(input.storePath);
    const live = activeLeases(store.leases, now);
    if (live.length === store.leases.length) return [];
    const dropped = store.leases
      .filter((lease) => !live.some((candidate) => candidate.id === lease.id))
      .map((lease) => lease.id);
    store.leases = live;
    await writeStore(input.storePath, store);
    return dropped;
  });
}

export async function transferResourceLeaseOwnership(
  input: TransferResourceLeaseOwnershipInput,
): Promise<ResourceLease | undefined> {
  if (!input.owner.trim()) {
    throw new Error("Resource lease owner must not be empty");
  }
  if (!input.expectedOwner.trim()) {
    throw new Error("Resource lease transfer requires the expected current owner");
  }
  if (!isPositiveSafeInteger(input.expectedFence)) {
    throw new Error("Resource lease transfer requires a positive expected fence");
  }
  const now = input.now ?? new Date();
  return withStoreLock(input.storePath, async () => {
    const store = await readStore(input.storePath);
    store.leases = activeLeases(store.leases, now);
    const lease = store.leases.find((candidate) => candidate.id === input.leaseId);
    if (!lease) {
      return undefined;
    }
    // Transfer used to prove nothing: any caller could reassign any lease to any
    // owner. `renewResourceLease` already checked ownership, so the asymmetry
    // was an oversight rather than a design.
    if (lease.owner !== input.expectedOwner) {
      throw new Error(
        `Resource lease ${input.leaseId} is owned by ${lease.owner}, not ${input.expectedOwner}`,
      );
    }
    if (lease.fence !== input.expectedFence) {
      throw new Error(
        `Resource lease ${input.leaseId} has fence ${lease.fence}, not ${input.expectedFence}`,
      );
    }
    if (!hasAvailableFence(store.nextFence)) {
      throw new Error("Resource lease fence space is exhausted");
    }
    lease.owner = input.owner;
    lease.heartbeatAt = now.toISOString();
    // A new owner gets a new fence: writes issued under the previous owner's
    // fence must stop being accepted the moment ownership moves.
    lease.fence = store.nextFence;
    store.nextFence += 1;
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
  if (!isPositiveSafeInteger(input.expectedFence)) {
    throw new Error("Resource lease renewal requires a positive expected fence");
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
    if (lease.fence !== input.expectedFence) {
      throw new Error(
        `Resource lease ${input.leaseId} has fence ${lease.fence}, not ${input.expectedFence}`,
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
  if (!input.expectedOwner.trim()) {
    throw new Error("Resource lease release requires the expected owner");
  }
  if (!isPositiveSafeInteger(input.expectedFence)) {
    throw new Error("Resource lease release requires a positive expected fence");
  }
  const now = input.now ?? new Date();
  return withStoreLock(input.storePath, async () => {
    const store = await readStore(input.storePath);
    const current = activeLeases(store.leases, now);
    const target = current.find((lease) => lease.id === input.leaseId);
    if (!target) {
      // Nothing to release. Still prune while we hold the lock.
      if (current.length !== store.leases.length) {
        store.leases = current;
        await writeStore(input.storePath, store);
      }
      return false;
    }
    if (target.owner !== input.expectedOwner) {
      throw new Error(
        `Resource lease ${input.leaseId} is owned by ${target.owner}, not ${input.expectedOwner}`,
      );
    }
    if (target.fence !== input.expectedFence) {
      throw new Error(
        `Resource lease ${input.leaseId} has fence ${target.fence}, not ${input.expectedFence}`,
      );
    }
    store.leases = current.filter((lease) => lease.id !== input.leaseId);
    await writeStore(input.storePath, store);
    return true;
  });
}

export interface ReleaseOrphanedLeasesInput {
  storePath: string;
  aliveOwnerIds: ReadonlySet<string>;
  now?: Date;
}

/**
 * Release active leases whose owner is no longer an alive task (Herdr §16.3 —
 * handle abandoned locks on crash/freeze/compact, don't wait for TTL expiry).
 * Returns the reaped lease ids.
 *
 * Runs inside a SINGLE lock. It used to snapshot the leases, drop the lock, and
 * then re-acquire it once per release — so a lease acquired between the snapshot
 * and its release was reaped on the strength of a stale observation.
 */
export async function releaseOrphanedLeases(
  input: ReleaseOrphanedLeasesInput,
): Promise<string[]> {
  const now = input.now ?? new Date();
  return withStoreLock(input.storePath, async () => {
    const store = await readStore(input.storePath);
    const active = activeLeases(store.leases, now);
    const orphaned = active.filter((lease) => !input.aliveOwnerIds.has(lease.owner));
    if (orphaned.length === 0 && active.length === store.leases.length) return [];
    const orphanIds = new Set(orphaned.map((lease) => lease.id));
    store.leases = active.filter((lease) => !orphanIds.has(lease.id));
    await writeStore(input.storePath, store);
    return [...orphanIds];
  });
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
  scope?: string;
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
  return leases
    .filter(
      (lease) =>
        leaseMatchesScope(lease.scope, input.scope) &&
        leaseCoversPath(lease, input.path),
    )
    .sort((left, right) => right.fence - left.fence)[0];
}

export interface AssertNoConflictingWriteInput {
  storePath: string;
  scope?: string;
  ownerTaskId: string;
  path: string;
  /**
   * The fence the caller was issued when it acquired its lease. When supplied,
   * a write is refused if the covering lease has moved past it — the caller's
   * lease lapsed and was re-acquired (possibly by itself) while it was not
   * looking, so its in-memory belief about the resource is stale.
   */
  fence?: number;
  now?: Date;
}

export async function assertNoConflictingWrite(
  input: AssertNoConflictingWriteInput,
): Promise<void> {
  if (input.fence !== undefined && !isPositiveSafeInteger(input.fence)) {
    throw new Error("Resource lease fence must be a positive safe integer");
  }
  const lease = await findClaimCoveringPath({
    storePath: input.storePath,
    scope: input.scope,
    path: input.path,
    now: input.now,
  });
  if (!lease) {
    return;
  }
  if (lease.owner === input.ownerTaskId) {
    if (input.fence !== undefined && lease.fence !== input.fence) {
      throw new Error(
        `Write blocked: ${input.path} is covered by a different lease generation ` +
          `(fence ${lease.fence} != ${input.fence}); this task's lease was superseded`,
      );
    }
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

function leaseScopesOverlap(left: string | undefined, right: string | undefined): boolean {
  // Unscoped leases predate multi-repo support and remain conservatively global
  // until they expire or are released.
  return left === undefined || right === undefined || left === right;
}

function leaseMatchesScope(
  leaseScope: string | undefined,
  requestedScope: string | undefined,
): boolean {
  return requestedScope === undefined || leaseScope === undefined || leaseScope === requestedScope;
}

function activeLeases(leases: readonly ResourceLease[], now: Date): ResourceLease[] {
  const timestamp = now.getTime();
  return leases.filter((lease) => Date.parse(lease.expiresAt) > timestamp);
}

function emptyStore(): ResourceLeaseStore {
  return { version: STORE_VERSION, nextFence: 1, leases: [] };
}

/**
 * Read the lease store, migrating older versions forward and quarantining a
 * store that cannot be understood.
 *
 * Throwing on a bad store was a denial of service on the whole write path: one
 * malformed claim made `readStore` throw, and every operation that touches
 * leases — acquire, renew, release, the write guard — threw with it, forever,
 * until someone deleted `leases.json` by hand. Quarantining moves the bad file
 * aside, reports it, and lets the system continue with an empty store.
 */
async function readStore(storePath: string): Promise<ResourceLeaseStore> {
  let raw: string;
  try {
    raw = await readFile(storePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return emptyStore();
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return quarantineStore(storePath, `unparseable JSON: ${(error as Error).message}`);
  }

  const migrated = migrateStore(value);
  if (!migrated) {
    return quarantineStore(storePath, "store failed schema validation");
  }
  return migrated;
}

/**
 * Bring a persisted store up to {@link STORE_VERSION}, or return undefined if it
 * is not a store this build understands.
 *
 * A version NEWER than this build is not an error to repair by force — it means
 * the user rolled back — so it is quarantined by the caller rather than
 * reinterpreted.
 */
function migrateStore(value: unknown): ResourceLeaseStore | undefined {
  if (!isRecord(value) || typeof value.version !== "number" || !Array.isArray(value.leases)) {
    return undefined;
  }
  if (!(SUPPORTED_STORE_VERSIONS as readonly number[]).includes(value.version)) {
    return undefined;
  }
  if (!value.leases.every(isPersistedLease)) return undefined;

  // v1 had no fences. Assign them in persisted order so existing leases keep a
  // stable relative generation, and start `nextFence` above all of them.
  if (value.version === 1) {
    if (value.leases.length >= Number.MAX_SAFE_INTEGER) return undefined;
    const leases = value.leases.map((lease, index) => ({
      ...lease,
      fence: index + 1,
    })) as ResourceLease[];
    return {
      version: STORE_VERSION,
      nextFence: leases.length + 1,
      leases,
    };
  }

  // A v2 fence is an authority token, not an advisory counter. Accepting zero,
  // negative, duplicate, or rewound values can make a stale writer current
  // again. Unlike v1, there is no safe migration because released generations
  // are no longer present in `leases`; quarantine instead of guessing.
  if (
    !isPositiveSafeInteger(value.nextFence) ||
    !value.leases.every(isResourceLease)
  ) {
    return undefined;
  }
  const leases = value.leases as ResourceLease[];
  const fences = new Set(leases.map((lease) => lease.fence));
  const maxFence = leases.reduce(
    (maximum, lease) => Math.max(maximum, lease.fence),
    0,
  );
  if (
    fences.size !== leases.length ||
    value.nextFence <= maxFence
  ) {
    return undefined;
  }
  const nextFence = value.nextFence;
  return { version: STORE_VERSION, nextFence, leases };
}

async function quarantineStore(storePath: string, reason: string): Promise<ResourceLeaseStore> {
  const quarantinePath = `${storePath}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`;
  try {
    await rename(storePath, quarantinePath);
  } catch {
    // If we cannot move it aside we still continue with an empty store rather
    // than bricking every write; the next write overwrites the bad file.
  }
  try {
    reportQuarantine({ storePath, quarantinePath, reason });
  } catch {
    // A reporter must never be able to break the store.
  }
  return emptyStore();
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

/** A lease as persisted — `fence` may be absent only while reading a v1 store. */
function isPersistedLease(
  value: unknown,
): value is Omit<ResourceLease, "fence"> & { fence?: number } {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof value.owner === "string" &&
    value.owner.trim().length > 0 &&
    (value.scope === undefined ||
      (typeof value.scope === "string" && value.scope.trim().length > 0)) &&
    typeof value.acquiredAt === "string" &&
    Number.isFinite(Date.parse(value.acquiredAt)) &&
    (value.heartbeatAt === undefined ||
      (typeof value.heartbeatAt === "string" &&
        Number.isFinite(Date.parse(value.heartbeatAt)))) &&
    typeof value.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.expiresAt)) &&
    Array.isArray(value.claims) &&
    value.claims.length > 0 &&
    value.claims.every(isPersistedClaim) &&
    (value.fence === undefined || isPositiveSafeInteger(value.fence))
  );
}

export function isResourceLease(value: unknown): value is ResourceLease {
  return isPersistedLease(value) && isPositiveSafeInteger(value.fence);
}

export function isResourceClaim(value: unknown): value is ResourceClaim {
  return (
    isRecord(value) &&
    (value.kind === "write" || value.kind === "test" || value.kind === "evidence") &&
    (value.mode === "shared" || value.mode === "exclusive") &&
    typeof value.resource === "string"
  );
}

function isPersistedClaim(value: unknown): value is ResourceClaim {
  if (!isResourceClaim(value) || !normalizeResource(value.resource)) return false;
  if (value.kind !== "write") return true;
  if (value.mode !== "exclusive") return false;
  const resource = normalizeResource(value.resource);
  return !(
    resource === ".." ||
    resource.startsWith("../") ||
    resource.includes("/../") ||
    isAbsolute(resource) ||
    /^[A-Za-z]:\//u.test(resource) ||
    resource.startsWith("//")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1
  );
}

function hasAvailableFence(value: unknown): value is number {
  return isPositiveSafeInteger(value) && value < Number.MAX_SAFE_INTEGER;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
