import {
  assistantInferenceProfileSchema,
  assistantReasoningModeSchema,
  type AssistantInferenceProfile,
  type AssistantModelProfileId,
  type AssistantReasoningMode,
} from "../contracts/api";

export const LEGACY_INFERENCE_PROFILES = ["legacy-fast", "legacy-normal", "legacy-deep"] as const;
export type LegacyInferenceProfile = (typeof LEGACY_INFERENCE_PROFILES)[number];

export type InferenceInputBudget = {
  /** Safe user-plus-selected-file正文 budget for an 8K-context runtime. */
  maxContextCharacters: number;
  /** User text is rejected above this value; it is never silently truncated. */
  maxUserCharacters: number;
  /** Remaining正文 budget available to selected knowledge files. */
  maxFileCharacters: number;
};

export type InferenceProfileSettings = {
  thinkingEnabled: boolean;
  maxOutputTokens: number;
  timeoutCeilingMs: number;
  maxContextCharacters: number;
  providerReasoningEffort: "none" | "low" | "medium" | "high" | "max";
};

/**
 * Application-facing profiles deliberately map to a bounded completion
 * budget. Qwen3's boolean thinking switch does not provide five native
 * reasoning levels; the higher profiles therefore spend progressively more
 * completion budget while retaining one explicit thinking switch.
 */
export const INFERENCE_PROFILE_SETTINGS: Record<AssistantInferenceProfile, InferenceProfileSettings> = {
  instant: {
    thinkingEnabled: false,
    maxOutputTokens: 1_024,
    timeoutCeilingMs: 120_000,
    maxContextCharacters: 4_000,
    providerReasoningEffort: "none",
  },
  medium: {
    thinkingEnabled: true,
    maxOutputTokens: 1_536,
    timeoutCeilingMs: 180_000,
    maxContextCharacters: 2_000,
    providerReasoningEffort: "medium",
  },
  high: {
    thinkingEnabled: true,
    maxOutputTokens: 2_560,
    timeoutCeilingMs: 240_000,
    maxContextCharacters: 2_000,
    providerReasoningEffort: "high",
  },
  "extra-high": {
    thinkingEnabled: true,
    maxOutputTokens: 4_096,
    timeoutCeilingMs: 300_000,
    maxContextCharacters: 1_500,
    providerReasoningEffort: "max",
  },
  pro: {
    thinkingEnabled: true,
    // The 14B route is the capability upgrade. Keep the completion budget at
    // 4K so an 8K context still has room for instructions, tool schemas and
    // tool results; Pro does not pretend to fit an 8K answer into that window.
    maxOutputTokens: 4_096,
    timeoutCeilingMs: 300_000,
    maxContextCharacters: 1_200,
    providerReasoningEffort: "max",
  },
};

const LEGACY_CONTEXT_CHARACTERS = 4_000;
const LEGACY_OUTPUT_BUDGETS: Record<LegacyInferenceProfile, number> = {
  "legacy-fast": 2_048,
  "legacy-normal": 8_192,
  "legacy-deep": 8_192,
};

export type InferencePolicyResolution = {
  requestedMode: AssistantReasoningMode;
  requestedProfile: AssistantInferenceProfile | null;
  resolvedMode: AssistantReasoningMode;
  resolvedProfile: AssistantInferenceProfile | LegacyInferenceProfile;
  requestedModelProfileId: AssistantModelProfileId;
  resolvedModelProfileId: AssistantModelProfileId;
  thinkingEnabled: boolean;
  maxOutputTokens: number;
  timeoutMs: number;
  inputBudget: InferenceInputBudget;
  providerReasoningEffort: InferenceProfileSettings["providerReasoningEffort"] | "legacy";
};

export class InferencePolicyError extends Error {
  constructor(public readonly status: 422 | 503, public readonly code: string, message: string) {
    super(message);
    this.name = "InferencePolicyError";
  }
}

function clampConfiguredTimeout(timeoutMs: number | undefined) {
  if (!Number.isFinite(timeoutMs)) return 120_000;
  return Math.min(300_000, Math.max(5_000, Math.trunc(timeoutMs as number)));
}

function legacyProfile(mode: "fast" | "normal" | "deep"): LegacyInferenceProfile {
  return mode === "fast" ? "legacy-fast" : mode === "normal" ? "legacy-normal" : "legacy-deep";
}

function inputBudget(maxContextCharacters: number): InferenceInputBudget {
  return {
    maxContextCharacters,
    maxUserCharacters: maxContextCharacters,
    // Route code subtracts the actual user text before loading selected files.
    maxFileCharacters: maxContextCharacters,
  };
}

export function isCurrentInferenceProfile(value: string): value is AssistantInferenceProfile {
  return assistantInferenceProfileSchema.safeParse(value).success;
}

/** Pure shared lookup for UI input-limit hints; it performs no model probing. */
export function getInferenceProfileInputBudget(profile: AssistantInferenceProfile) {
  return INFERENCE_PROFILE_SETTINGS[assistantInferenceProfileSchema.parse(profile)].maxContextCharacters;
}

/**
 * Resolve the public request into a server-owned model/profile policy. The
 * model profile is never taken from a URL, model name, or credential. Pro is
 * intentionally local-only: a configured custom service cannot be silently
 * substituted, and an 8B request is made explicit as a 14B route.
 */
export function resolveInferencePolicy(input: {
  mode: AssistantReasoningMode;
  modelProfileId?: AssistantModelProfileId;
  configuredTimeoutMs?: number;
  modelMaxOutputTokens?: number;
}): InferencePolicyResolution {
  const mode = assistantReasoningModeSchema.parse(input.mode);
  const requestedModelProfileId = input.modelProfileId ?? "configured";
  const configuredTimeoutMs = input.configuredTimeoutMs === undefined
    ? undefined
    : clampConfiguredTimeout(input.configuredTimeoutMs);

  if (!isCurrentInferenceProfile(mode)) {
    const profile = legacyProfile(mode);
    return {
      requestedMode: mode,
      requestedProfile: null,
      resolvedMode: mode,
      resolvedProfile: profile,
      requestedModelProfileId,
      resolvedModelProfileId: requestedModelProfileId,
      thinkingEnabled: mode !== "fast",
      maxOutputTokens: input.modelMaxOutputTokens === undefined
        ? LEGACY_OUTPUT_BUDGETS[profile]
        : Math.min(LEGACY_OUTPUT_BUDGETS[profile], input.modelMaxOutputTokens),
      timeoutMs: configuredTimeoutMs ?? 120_000,
      inputBudget: inputBudget(LEGACY_CONTEXT_CHARACTERS),
      providerReasoningEffort: "legacy",
    };
  }

  const settings = INFERENCE_PROFILE_SETTINGS[mode];
  if (requestedModelProfileId === "configured" && mode !== "instant") {
    if (mode === "pro") {
      throw new InferencePolicyError(503, "PRO_MODEL_REQUIRED", "Pro requires the installed local qwen3:14b model; a custom service cannot be used as a silent fallback.");
    }
    throw new InferencePolicyError(422, "MODEL_PROFILE_MODE_UNSUPPORTED", `The configured model profile only exposes the instant inference mode.`);
  }

  const resolvedModelProfileId = mode === "pro" && requestedModelProfileId === "local-qwen3-8b"
    ? "local-qwen3-14b"
    : requestedModelProfileId;
  const maxOutputTokens = input.modelMaxOutputTokens === undefined
    ? settings.maxOutputTokens
    : Math.min(settings.maxOutputTokens, input.modelMaxOutputTokens);

  return {
    requestedMode: mode,
    requestedProfile: mode,
    resolvedMode: mode,
    resolvedProfile: mode,
    requestedModelProfileId,
    resolvedModelProfileId,
    thinkingEnabled: settings.thinkingEnabled,
    maxOutputTokens,
    timeoutMs: configuredTimeoutMs === undefined
      ? settings.timeoutCeilingMs
      : Math.min(configuredTimeoutMs, settings.timeoutCeilingMs),
    inputBudget: inputBudget(settings.maxContextCharacters),
    providerReasoningEffort: settings.providerReasoningEffort,
  };
}

/** Apply provider-specific output ceilings while preserving the audit fields. */
export function withModelOutputBudget(policy: InferencePolicyResolution, modelMaxOutputTokens: number) {
  return {
    ...policy,
    maxOutputTokens: Math.min(policy.maxOutputTokens, modelMaxOutputTokens),
  };
}

export function inputBudgetHeader(policy: InferencePolicyResolution) {
  return String(policy.inputBudget.maxContextCharacters);
}

export function inputBudgetDetailsHeader(policy: InferencePolicyResolution) {
  return JSON.stringify(policy.inputBudget);
}
