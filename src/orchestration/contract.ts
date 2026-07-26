import { Type, type Static } from "typebox";
import { parseLearningClaims } from "../learning-contract.js";
import type { ResourceClaim } from "./claims.js";
import type { ContextPackInput } from "./context.js";

const ResourceClaimSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("write"),
      Type.Literal("test"),
      Type.Literal("evidence"),
    ]),
    resource: Type.String({ minLength: 1 }),
    mode: Type.Union([Type.Literal("shared"), Type.Literal("exclusive")]),
  },
  { additionalProperties: false },
);

const ContextFactSchema = Type.Object(
  {
    statement: Type.String({ minLength: 1 }),
    source: Type.Union([
      Type.Literal("user"),
      Type.Literal("repository"),
      Type.Literal("delegated"),
      Type.Literal("external"),
    ]),
    reference: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const ContextDecisionSchema = Type.Object(
  {
    statement: Type.String({ minLength: 1 }),
    rationale: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const ContextEvidenceSchema = Type.Object(
  {
    description: Type.String({ minLength: 1 }),
    reference: Type.String({ minLength: 1 }),
    recorded_at: Type.Optional(Type.String()),
    claim: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const TaggedDigestSchema = Type.String({ pattern: "^sha256:v1:[0-9a-f]{64}$" });
const LearningReferenceSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("evidence-receipt"),
      Type.Literal("repository-file"),
    ]),
    ref: Type.String({ minLength: 1, maxLength: 512 }),
    digest: TaggedDigestSchema,
  },
  { additionalProperties: false },
);
const LearningClaimSchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Union([Type.Literal("pattern"), Type.Literal("discovery")]),
    claimId: TaggedDigestSchema,
    statement: Type.String({ minLength: 1, maxLength: 400 }),
    applicability: Type.String({ minLength: 1, maxLength: 300 }),
    support: Type.Object(
      {
        mode: Type.Union([Type.Literal("direct-artifact"), Type.Literal("task-outcome")]),
        evidenceRefs: Type.Array(LearningReferenceSchema, { minItems: 1, maxItems: 16 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const ContextPackInputSchema = Type.Object(
  {
    goal: Type.String({ minLength: 1 }),
    authorization: Type.Union([
      Type.Literal("read-only"),
      Type.Literal("write-approved"),
      Type.Literal("sensitive-approved"),
    ]),
    known_facts: Type.Optional(Type.Array(ContextFactSchema)),
    unknowns: Type.Optional(Type.Array(Type.String())),
    decisions: Type.Optional(Type.Array(ContextDecisionSchema)),
    references: Type.Optional(
      Type.Array(
        Type.Object(
          { path: Type.String({ minLength: 1 }) },
          { additionalProperties: false },
        ),
      ),
    ),
    evidence: Type.Optional(Type.Array(ContextEvidenceSchema)),
    claims: Type.Optional(Type.Array(Type.String())),
    learning_claims: Type.Optional(Type.Array(LearningClaimSchema, { maxItems: 32 })),
    next_step: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const ProofPolicySchema = Type.Object(
  {
    mode: Type.Literal("evidence-only"),
    max_evidence_age_ms: Type.Optional(Type.Number({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const OrchestrationRequestSchema = Type.Object(
  {
    id: Type.Optional(Type.String({ minLength: 1 })),
    batch_id: Type.Optional(Type.String({ minLength: 1 })),
    join: Type.Optional(
      Type.Union([Type.Literal("async"), Type.Literal("group")]),
    ),
    isolation: Type.Optional(Type.Literal("worktree")),
    schedule: Type.Optional(
      Type.Object(
        {
          cron: Type.Optional(Type.String({ minLength: 1 })),
          at: Type.Optional(Type.String({ minLength: 1 })),
          timezone: Type.Optional(Type.String({ minLength: 1 })),
          max_runs: Type.Optional(Type.Integer({ minimum: 1 })),
        },
        { additionalProperties: false },
      ),
    ),
    claims: Type.Optional(Type.Array(ResourceClaimSchema)),
    lease_ttl_ms: Type.Optional(Type.Number({ minimum: 1_000 })),
    context: Type.Optional(ContextPackInputSchema),
    proof: Type.Optional(ProofPolicySchema),
    verifier: Type.Optional(
      Type.Object(
        {
          required: Type.Boolean(),
          reviewer_agent: Type.Optional(Type.String()),
          min_reviews: Type.Optional(Type.Number({ minimum: 1 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

type PublicOrchestrationRequest = Static<typeof OrchestrationRequestSchema>;

export interface OrchestrationRequest {
  id?: string;
  batchId?: string;
  join?: "async" | "group";
  isolation?: "worktree";
  schedule?: {
    cron?: string;
    at?: string;
    timezone?: string;
    maxRuns?: number;
  };
  claims?: ResourceClaim[];
  leaseTtlMs?: number;
  context?: ContextPackInput;
  proof?: {
    mode: "evidence-only";
    maxEvidenceAgeMs?: number;
  };
  verifier?: {
    required: boolean;
    reviewerAgent?: string;
    minReviews?: number;
  };
}

export function parseOrchestrationRequest(
  value: unknown,
): OrchestrationRequest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const publicValue = value as PublicOrchestrationRequest;
  return {
    ...(publicValue.id ? { id: publicValue.id } : {}),
    ...(publicValue.batch_id ? { batchId: publicValue.batch_id } : {}),
    ...(publicValue.join ? { join: publicValue.join } : {}),
    ...(publicValue.isolation ? { isolation: publicValue.isolation } : {}),
    ...(publicValue.schedule
      ? { schedule: normalizeSchedule(publicValue.schedule) }
      : {}),
    ...(publicValue.claims
      ? { claims: publicValue.claims.map((claim) => ({ ...claim })) }
      : {}),
    ...(publicValue.lease_ttl_ms
      ? { leaseTtlMs: publicValue.lease_ttl_ms }
      : {}),
    ...(publicValue.context
      ? { context: normalizeContext(publicValue.context) }
      : {}),
    ...(publicValue.proof
      ? {
          proof: {
            mode: "evidence-only",
            ...(publicValue.proof.max_evidence_age_ms
              ? { maxEvidenceAgeMs: publicValue.proof.max_evidence_age_ms }
              : {}),
          },
        }
      : {}),
    ...(publicValue.verifier
      ? {
          verifier: {
            required: publicValue.verifier.required,
            ...(publicValue.verifier.reviewer_agent
              ? { reviewerAgent: publicValue.verifier.reviewer_agent }
              : {}),
            ...(publicValue.verifier.min_reviews
              ? { minReviews: publicValue.verifier.min_reviews }
              : {}),
          },
        }
      : {}),
  };
}

function normalizeSchedule(
  schedule: NonNullable<PublicOrchestrationRequest["schedule"]>,
): NonNullable<OrchestrationRequest["schedule"]> {
  if (Boolean(schedule.cron) === Boolean(schedule.at)) {
    throw new Error("orchestration.schedule requires exactly one of cron or at");
  }
  if (schedule.at && !Number.isFinite(Date.parse(schedule.at))) {
    throw new Error("orchestration.schedule.at must be an ISO date-time");
  }
  return {
    ...(schedule.cron ? { cron: schedule.cron } : {}),
    ...(schedule.at ? { at: schedule.at } : {}),
    ...(schedule.timezone ? { timezone: schedule.timezone } : {}),
    ...(schedule.max_runs ? { maxRuns: schedule.max_runs } : {}),
  };
}

function normalizeContext(
  context: NonNullable<PublicOrchestrationRequest["context"]>,
): ContextPackInput {
  return {
    goal: context.goal,
    authorization: context.authorization,
    ...(context.known_facts
      ? { knownFacts: context.known_facts.map((fact) => ({ ...fact })) }
      : {}),
    ...(context.unknowns ? { unknowns: [...context.unknowns] } : {}),
    ...(context.decisions
      ? { decisions: context.decisions.map((decision) => ({ ...decision })) }
      : {}),
    ...(context.references
      ? { references: context.references.map((reference) => ({ ...reference })) }
      : {}),
    ...(context.evidence
      ? {
          evidence: context.evidence.map((evidence) => ({
            description: evidence.description,
            reference: evidence.reference,
            ...(evidence.recorded_at
              ? { recordedAt: evidence.recorded_at }
              : {}),
            ...(evidence.claim ? { claim: evidence.claim } : {}),
          })),
        }
      : {}),
    ...(context.claims ? { claims: [...context.claims] } : {}),
    ...(context.learning_claims
      ? { learningClaims: parseLearningClaims(context.learning_claims) }
      : {}),
    nextStep: context.next_step,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
