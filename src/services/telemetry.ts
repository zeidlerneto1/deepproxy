/*
 * File: telemetry.ts
 * Project: deepsproxy
 * Telemetry system to automatically detect and estimate model context window limits based on usage.
 */

export interface ModelTelemetry {
  detectedLimit: number; // in characters
  maxSuccessSize: number; // in characters
  minFailureSize: number; // in characters
}

const DEFAULT_CONTEXT_CHARACTERS = 64_000 * 3.5; // Roughly 224,000 characters (representing 64,000 tokens)
const MIN_CONTEXT_CHARACTERS = 50 * 3.5; // 175 characters (representing 50 tokens)

// Dynamically discovered limits (tokens), keyed by model id, set by
// applyDiscoveredModels(). Falls back to MODEL_CONTEXT_LIMITS until populated.
const discoveredLimits: Record<string, number> = (globalThis as any)._discoveredLimits || {};
(globalThis as any)._discoveredLimits = discoveredLimits;

// Real-world context limits per model (in tokens). These act as a hard cap so
// the adaptive telemetry never inflates the limit beyond what chat.deepseek.com
// actually accepts. The `pro` variants have a much smaller window than `flash`.
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'deepseek-v4-flash': 64_000,
  'deepseek-v4-flash-thinking': 64_000,
  'deepseek-v4-pro': 20_000,
  'deepseek-v4-pro-thinking': 20_000,
};

function modelContextLimitTokens(model: string): number {
  // Prefer the dynamically discovered real limit; fall back to the manual caps.
  if (discoveredLimits[model]) return discoveredLimits[model];
  return MODEL_CONTEXT_LIMITS[model] ?? 64_000;
}

interface DiscoveredModelShape {
  id: string;
  maxInputTokens: number;
}

/**
 * Populate the per-model context caps from dynamically discovered models
 * (see services/models.ts). Keeps the manual caps as a fallback.
 */
export function applyDiscoveredModels(discovered: DiscoveredModelShape[]): void {
  for (const m of discovered) {
    if (m.maxInputTokens > 0) {
      discoveredLimits[m.id] = m.maxInputTokens;
    }
  }
}

const telemetryStore: Record<string, ModelTelemetry> = (globalThis as any)._telemetryStore || {};
(globalThis as any)._telemetryStore = telemetryStore;

function initTelemetry(model: string): ModelTelemetry {
  if (!telemetryStore[model]) {
    const capTokens = modelContextLimitTokens(model);
    telemetryStore[model] = {
      detectedLimit: Math.min(DEFAULT_CONTEXT_CHARACTERS, capTokens * 3.5),
      maxSuccessSize: 0,
      minFailureSize: Infinity,
    };
  }
  return telemetryStore[model];
}

export function getModelTelemetry(model: string): ModelTelemetry {
  return initTelemetry(model);
}

export function getContextLength(model: string): number {
  const stats = initTelemetry(model);
  // Return in tokens (assuming roughly 3.5 characters per token)
  return Math.ceil(stats.detectedLimit / 3.5);
}

// Hard cap in characters: never exceed the real model context limit.
function applyModelCap(model: string, limitChars: number): number {
  const capChars = modelContextLimitTokens(model) * 3.5;
  return Math.min(limitChars, capChars);
}

export function recordSuccess(model: string, promptSize: number): void {
  const stats = initTelemetry(model);
  stats.maxSuccessSize = Math.max(stats.maxSuccessSize, promptSize);
  
  // If the successful prompt was larger than our estimated limit, increase the limit
  if (promptSize > stats.detectedLimit) {
    stats.detectedLimit = promptSize;
  }
  
  // Ensure detectedLimit is not above minFailureSize if we have recorded a failure
  if (stats.detectedLimit >= stats.minFailureSize) {
    stats.detectedLimit = Math.floor(stats.minFailureSize * 0.95);
  }
  
  // Never exceed the real model context window, regardless of telemetry.
  stats.detectedLimit = applyModelCap(model, stats.detectedLimit);
  
  console.log(`[Telemetry] Recorded success for model '${model}'. Prompt size: ${promptSize} chars. Estimated context limit: ${stats.detectedLimit} chars (cap ${Math.floor(modelContextLimitTokens(model) * 3.5)} chars).`);
}

export function recordFailure(model: string, promptSize: number): void {
  const stats = initTelemetry(model);
  stats.minFailureSize = Math.min(stats.minFailureSize, promptSize);
  
  // On failure, adjust the estimated limit downwards.
  // We estimate the new limit as 85% of the failed prompt size
  const newLimit = Math.floor(promptSize * 0.85);
  
  // Do not let it drop below our safe minimum context size
  stats.detectedLimit = Math.max(MIN_CONTEXT_CHARACTERS, Math.min(stats.detectedLimit, newLimit));
  
  // Keep it above the maximum known success size
  if (stats.detectedLimit < stats.maxSuccessSize) {
    stats.detectedLimit = stats.maxSuccessSize;
  }
  
  // Never exceed the real model context window, regardless of telemetry.
  stats.detectedLimit = applyModelCap(model, stats.detectedLimit);
  
  console.log(`[Telemetry] Recorded failure for model '${model}'. Prompt size: ${promptSize} chars. Estimated context limit: ${stats.detectedLimit} chars (cap ${Math.floor(modelContextLimitTokens(model) * 3.5)} chars).`);
}
