/**
 * The gate: verify, then apply the tier's policy, then hand back a decision an adapter
 * can turn into an HTTP response. This is where the framework adapters converge, and
 * it is the layer to call directly from anything this package has no adapter for.
 *
 * Like `verify`, it does not throw for anything a client can put in a request. Every
 * malformed-input path produces a decision.
 */

import type { NormalizedHeaders } from './headers.js';
import { forwardedClientAddress, readProofHeader, tryNormalizeHeaders } from './headers.js';
import type { RateLimitDecision } from './ratelimit.js';
import { enforceRateLimit } from './ratelimit.js';
import type { TierPolicies, TierPolicy } from './tiers.js';
import { DEFAULT_TIER_POLICIES } from './tiers.js';
import type {
  AgentTier,
  AnonymousVerification,
  HumanBackedIdentity,
  VerifiableRequest,
  VerificationResult,
} from './types.js';
import type { AgentTierVerifier, VerifierOptions } from './verify.js';
import { createAgentTierVerifier, normalizeRequestHeaders } from './verify.js';

/**
 * What to do when a caller presents a proof that does not hold up.
 *
 * `downgrade` is the default and matches the product: the request proceeds with
 * anonymous limits. `reject` answers 401 instead, and is the right setting on an
 * endpoint where a broken proof means a broken client that should be told so rather
 * than silently served at a tenth of the rate it expects.
 *
 * A caller that sends nothing at all is never rejected under either setting. Only the
 * proof header can make `presented` true, which is why duplicates of any other header
 * are merged rather than refused — see `tryNormalizeHeaders`.
 */
export type InvalidProofPolicy = 'downgrade' | 'reject';

export interface GateProblem {
  readonly status: 401 | 429;
  readonly code: 'invalid_agent_proof' | 'rate_limited';
  readonly detail: string;
}

export interface GateDecision {
  /** False only when `problem` is set. */
  readonly ok: boolean;
  readonly status: 200 | 401 | 429;
  readonly tier: AgentTier;
  readonly policy: TierPolicy;
  readonly identity: HumanBackedIdentity | null;
  readonly verification: VerificationResult;
  readonly rateLimit: RateLimitDecision;
  /** The rate-limit bucket this request was counted against. */
  readonly subject: string;
  /** Response headers to merge, already lowercase. */
  readonly headers: Readonly<Record<string, string>>;
  readonly problem: GateProblem | null;
}

/**
 * Attribute a request to a rate-limit bucket. `headers` is the same normalised map the
 * verifier read, so a resolver never has to parse raw headers again.
 */
export type SubjectResolver = (
  request: VerifiableRequest,
  result: VerificationResult,
  headers: NormalizedHeaders,
) => string;

/** Attribute a request to a verification budget before anything about it is known. */
export type VerificationSubjectResolver = (
  request: VerifiableRequest,
  headers: NormalizedHeaders,
) => string;

export interface GateOptions extends VerifierOptions {
  readonly policies?: TierPolicies | undefined;
  readonly onInvalidProof?: InvalidProofPolicy | undefined;
  /**
   * Attribute a request to a rate-limit bucket. Human-backed requests are keyed on the
   * wallet, which is unforgeable. For anonymous requests the default falls back to
   * `x-forwarded-for` and then to a single shared bucket, which is only acceptable
   * behind a proxy you control — supply your own resolver otherwise, or one abusive
   * caller spends everyone's budget.
   *
   * The default key changes when the tier changes, so one caller that stops presenting
   * its proof moves from `wallet:…` to `ip:…` and gets the anonymous allowance on top of
   * the human-backed one it already spent. Bounded, but real; see the note in
   * `ratelimit.ts`. A resolver that keys both tiers on something the caller cannot drop —
   * an API key, a mutual-TLS identity — is the fix, and only you have one.
   */
  readonly subject?: SubjectResolver | undefined;
  /** Set false to verify and tier without counting. Disables the verification budget too. Default true. */
  readonly enforceRateLimit?: boolean | undefined;
  /**
   * How many proof-presenting requests one source may have verified per window, before
   * the gate stops verifying and answers 429.
   *
   * Verification is the expensive half of this package: a secp256k1 recovery and an
   * AgentBook read, both of which a caller can force with a signature over a key it
   * generated a moment ago. The ordinary rate limit cannot bound them, because it runs
   * after verification — it has to, since the bucket a human-backed caller belongs in is
   * not known until the proof has been checked.
   *
   * The tightest honest bound is therefore the largest allowance any caller could turn
   * out to be entitled to, which is the human-backed limit, and that is the default.
   * Requests carrying no proof header are never counted here, because they cost nothing
   * to tier. Set `null` to disable.
   *
   * The budget is per verification subject, so callers that cannot be told apart share
   * one — the same caveat the anonymous rate-limit bucket carries.
   */
  readonly verificationBudget?: number | null | undefined;
  /**
   * Bucket for the verification budget. Nothing about the caller has been established
   * when this runs, so it can only key on the request itself; the default is the
   * anonymous half of {@link defaultSubject}.
   */
  readonly verificationSubject?: VerificationSubjectResolver | undefined;
  readonly onRateLimitStorageError?: ((error: unknown) => void) | undefined;
}

export interface AgentTierGate {
  readonly verifier: AgentTierVerifier;
  readonly policies: TierPolicies;
  evaluate(request: VerifiableRequest): Promise<GateDecision>;
}

/** The bucket every unattributable anonymous caller shares. Named so it is greppable. */
export const SHARED_ANONYMOUS_SUBJECT = 'anonymous:unattributed';

/**
 * Prefix on the verification budget's key. A distinct key space from the ordinary
 * rate-limit bucket, so a request is never counted twice against the same counter.
 */
export const VERIFICATION_SUBJECT_PREFIX = 'verify:';

/**
 * The bucket an anonymous caller belongs in: its forwarded address, or the shared one.
 * Split out because the verification budget needs it before a tier exists.
 */
export function anonymousSubject(headers: NormalizedHeaders): string {
  const forwarded = forwardedClientAddress(headers);
  return forwarded === undefined ? SHARED_ANONYMOUS_SUBJECT : `ip:${forwarded}`;
}

/**
 * `headers` is the normalised map; the gate always passes it. It is optional only so
 * this stays callable from outside the gate, where raw headers are what you have.
 */
export function defaultSubject(
  request: VerifiableRequest,
  result: VerificationResult,
  headers?: NormalizedHeaders,
): string {
  if (result.tier === 'human-backed') return `wallet:${result.identity.wallet}`;
  return anonymousSubject(headers ?? tryNormalizeHeaders(request.headers).headers);
}

export function createAgentTierGate(options: GateOptions): AgentTierGate {
  const verifier = createAgentTierVerifier(options);
  const policies = options.policies ?? DEFAULT_TIER_POLICIES;
  const onInvalidProof = options.onInvalidProof ?? 'downgrade';
  const subjectOf = options.subject ?? defaultSubject;
  const verificationSubjectOf =
    options.verificationSubject ?? ((_request: VerifiableRequest, headers: NormalizedHeaders) =>
      anonymousSubject(headers));
  const counting = options.enforceRateLimit ?? true;
  const clock = options.clock ?? Date.now;
  const verificationPolicy = buildVerificationPolicy(policies, options.verificationBudget);

  async function evaluate(request: VerifiableRequest): Promise<GateDecision> {
    // Normalised once, here, and passed down. Doing it again further in is how the gate
    // ended up throwing on input `verify` handles: nothing below this line may throw for
    // a request a client can send.
    const { headers, refusal } = normalizeRequestHeaders(request.headers, verifier.proofHeader);
    const nowMs = clock();

    if (counting && verificationPolicy !== null && refusal === null) {
      const presented = readProofHeader(headers, verifier.proofHeader) !== undefined;
      if (presented) {
        const subject = `${VERIFICATION_SUBJECT_PREFIX}${verificationSubjectOf(request, headers)}`;
        const attempt = await enforceRateLimit({
          storage: options.storage,
          subject,
          policy: verificationPolicy,
          nowMs,
          onStorageError: options.onRateLimitStorageError,
        });
        if (!attempt.allowed) return budgetExhausted(subject, attempt, nowMs, verificationPolicy);
      }
    }

    const verification = refusal ?? (await verifier.verifyNormalized(headers, request));
    const tier = verification.tier;
    const policy = policies[tier];
    const subject = subjectOf(request, verification, headers);

    const rateLimit = counting
      ? await enforceRateLimit({
          storage: options.storage,
          subject,
          policy,
          nowMs,
          onStorageError: options.onRateLimitStorageError,
        })
      : notCounted(policy, nowMs);

    const identity = verification.tier === 'human-backed' ? verification.identity : null;
    const headersOut = advisoryHeaders(tier, rateLimit, nowMs, verification);

    const rejectingProof =
      onInvalidProof === 'reject' && verification.tier === 'anonymous' && verification.presented;

    if (rejectingProof) {
      return {
        ok: false,
        status: 401,
        tier,
        policy,
        identity,
        verification,
        rateLimit,
        subject,
        headers: headersOut,
        problem: {
          status: 401,
          code: 'invalid_agent_proof',
          detail: verification.detail,
        },
      };
    }

    if (!rateLimit.allowed) {
      return {
        ok: false,
        status: 429,
        tier,
        policy,
        identity,
        verification,
        rateLimit,
        subject,
        headers: { ...headersOut, 'retry-after': String(rateLimit.retryAfterSeconds) },
        problem: {
          status: 429,
          code: 'rate_limited',
          detail:
            tier === 'anonymous'
              ? `anonymous agents may make ${rateLimit.limit} requests per ${policy.rateLimit.windowMs}ms; ` +
                'register the wallet with AgentKit for the human-backed limit'
              : `${rateLimit.limit} requests per ${policy.rateLimit.windowMs}ms exceeded`,
        },
      };
    }

    return {
      ok: true,
      status: 200,
      tier,
      policy,
      identity,
      verification,
      rateLimit,
      subject,
      headers: headersOut,
      problem: null,
    };
  }

  /**
   * The proof was never looked at, so the caller is anonymous by default rather than by
   * a finding about its proof. Returned before the `onInvalidProof` branch on purpose: a
   * 401 titled "Invalid agent proof" would be a claim about a proof this server declined
   * to read.
   */
  function budgetExhausted(
    subject: string,
    rateLimit: RateLimitDecision,
    nowMs: number,
    policy: TierPolicy,
  ): GateDecision {
    const verification: AnonymousVerification = {
      tier: 'anonymous',
      presented: true,
      reason: 'verification_budget_exhausted',
      detail:
        `this server verifies at most ${rateLimit.limit} proofs per ` +
        `${policy.rateLimit.windowMs}ms from one source, and that budget is spent`,
    };
    return {
      ok: false,
      status: 429,
      tier: 'anonymous',
      policy: policies.anonymous,
      identity: null,
      verification,
      rateLimit,
      subject,
      headers: {
        ...advisoryHeaders('anonymous', rateLimit, nowMs, verification),
        'retry-after': String(rateLimit.retryAfterSeconds),
      },
      problem: { status: 429, code: 'rate_limited', detail: verification.detail },
    };
  }

  return { verifier, policies, evaluate };
}

function advisoryHeaders(
  tier: AgentTier,
  rateLimit: RateLimitDecision,
  nowMs: number,
  verification: VerificationResult,
): Record<string, string> {
  const headers: Record<string, string> = {
    'x-agent-tier': tier,
    'ratelimit-limit': String(rateLimit.limit),
    'ratelimit-remaining': String(rateLimit.remaining),
    'ratelimit-reset': String(Math.max(0, Math.ceil((rateLimit.resetAtMs - nowMs) / 1000))),
  };
  // Told to the client only when it tried, so a normal anonymous caller gets no
  // header it did not ask for and a broken client gets the reason without reading logs.
  if (verification.tier === 'anonymous' && verification.presented) {
    headers['x-agent-proof-status'] = verification.reason;
  }
  return headers;
}

/**
 * The budget is expressed as a policy because that is what the limiter takes. It borrows
 * the human-backed window so the two counters roll over together.
 */
function buildVerificationPolicy(
  policies: TierPolicies,
  configured: number | null | undefined,
): TierPolicy | null {
  const humanBacked = policies['human-backed'];
  const requests = configured === undefined ? humanBacked.rateLimit.requests : configured;
  if (requests === null) return null;
  if (!Number.isInteger(requests) || requests <= 0) {
    throw new RangeError(`verificationBudget must be a positive integer or null, got ${requests}`);
  }
  return { ...humanBacked, rateLimit: { requests, windowMs: humanBacked.rateLimit.windowMs } };
}

function notCounted(policy: TierPolicy, nowMs: number): RateLimitDecision {
  const { requests, windowMs } = policy.rateLimit;
  return {
    allowed: true,
    limit: requests,
    used: 0,
    remaining: requests,
    windowStartMs: nowMs,
    resetAtMs: nowMs + windowMs,
    retryAfterSeconds: 0,
    degraded: false,
  };
}
