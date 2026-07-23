import { Type, type Static } from "@sinclair/typebox";
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
    claims: Type.Optional(Type.Array(ResourceClaimSchema)),
    lease_ttl_ms: Type.Optional(Type.Number({ minimum: 1 })),
    context: Type.Optional(ContextPackInputSchema),
    proof: Type.Optional(ProofPolicySchema),
  },
  { additionalProperties: false },
);

type PublicOrchestrationRequest = Static<typeof OrchestrationRequestSchema>;

export interface OrchestrationRequest {
  id?: string;
  claims?: ResourceClaim[];
  leaseTtlMs?: number;
  context?: ContextPackInput;
  proof?: {
    mode: "evidence-only";
    maxEvidenceAgeMs?: number;
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
          })),
        }
      : {}),
    nextStep: context.next_step,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
