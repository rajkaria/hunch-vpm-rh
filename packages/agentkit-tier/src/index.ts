/**
 * @hunch-vpm/agentkit-tier
 *
 * Verify a World AgentKit proof, decide which tier the caller is in, and apply that
 * tier's limits. Core is framework-free; adapters for Hono, plain Node and the fetch
 * API live behind the `./hono`, `./node` and `./fetch` subpath exports.
 */

export type {
  Address,
  AgentBookRecord,
  AgentKitProof,
  AgentTier,
  AnonymousVerification,
  HeaderSource,
  Hex,
  HumanBackedIdentity,
  HumanBackedVerification,
  SiweFields,
  SupportedChainId,
  VerifiableRequest,
  VerificationFailureCode,
  VerificationResult,
} from './types.js';
export { AGENT_BOOK_CHAIN_ID, SUPPORTED_CHAIN_IDS, isSupportedChainId } from './types.js';

export type { HeaderNormalization, NormalizedHeaders } from './headers.js';
export {
  ConflictingHeaderError,
  DEFAULT_PROOF_HEADER,
  forwardedClientAddress,
  normalizeHeaders,
  readProofHeader,
  tryNormalizeHeaders,
} from './headers.js';

export type { SiweMessageInput, SiweParseResult } from './siwe.js';
export {
  AGENTKIT_STATEMENT,
  formatSiweMessage,
  isAddressLike,
  isSignatureLike,
  lowercaseAddress,
  parseChainId,
  parseSiweMessage,
  parseTimestamp,
} from './siwe.js';

export type { EnvelopeParseResult, ProofEnvelope } from './proof.js';
export { encodeBase64Url, encodeProofHeader, parseProofHeader } from './proof.js';

export type {
  AgentBookRegistry,
  CachingAgentBookOptions,
  StaticAgentBookRecords,
  ViemAgentBookOptions,
} from './agentbook.js';
export {
  AGENT_BOOK_ABI,
  AgentBookConfigurationError,
  CANONICAL_AGENT_BOOK,
  PLACEHOLDER_ADDRESS,
  UNREGISTERED,
  createCachingAgentBook,
  createStaticAgentBook,
  createViemAgentBook,
  isPlaceholderAddress,
} from './agentbook.js';

export type { InMemoryTierStorageOptions, NonceOutcome, TierStorage } from './storage.js';
export { InMemoryTierStorage, nonceKey, rateLimitKey } from './storage.js';

export type {
  AcceptanceInput,
  AcceptanceResult,
  LeaderboardPolicy,
  LeaderboardPresentation,
  OpposingBook,
  RateLimitPolicy,
  TierPolicies,
  TierPolicy,
  TierPolicyOptions,
} from './tiers.js';
export {
  DEFAULT_ANONYMOUS_PER_MARKET_CAP,
  DEFAULT_BASE_REQUESTS,
  DEFAULT_TIER_POLICIES,
  DEFAULT_WINDOW_MS,
  HUMAN_BACKED_RATE_MULTIPLIER,
  UNBOUNDED_HEADROOM,
  buildTierPolicies,
  effectiveAcceptance,
  leaderboardPresentation,
} from './tiers.js';

export type { EnforceRateLimitInput, RateLimitDecision } from './ratelimit.js';
export { enforceRateLimit, windowStartFor } from './ratelimit.js';

export type {
  AgentTierVerifier,
  NormalizedRequestHeaders,
  SignerRecovery,
  VerifierOptions,
} from './verify.js';
export {
  AgentTierConfigurationError,
  createAgentTierVerifier,
  defaultSignerRecovery,
  normalizeRequestHeaders,
} from './verify.js';

export type {
  AgentTierGate,
  GateDecision,
  GateOptions,
  GateProblem,
  InvalidProofPolicy,
  SubjectResolver,
  VerificationSubjectResolver,
} from './gate.js';
export {
  SHARED_ANONYMOUS_SUBJECT,
  VERIFICATION_SUBJECT_PREFIX,
  anonymousSubject,
  createAgentTierGate,
  defaultSubject,
} from './gate.js';

export type { BuildProofInput, BuiltProof, MessageSigner } from './client.js';
export { buildProof } from './client.js';
