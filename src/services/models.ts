/*
 * File: models.ts
 * Project: deepsproxy
 * Dynamic model discovery from the DeepSeek web client settings endpoint.
 *
 * DeepSeek exposes the real model capabilities (including max_input_tokens) at
 * GET /api/v0/client/settings (scope=model). We use it to replace the manual
 * per-model context caps with the actual limits, and refresh periodically so we
 * stay correct when DeepSeek changes them.
 */

import { getDeepSeekHeaders } from './playwright.ts';
import { Agent, fetch as undiciFetch } from 'undici';

export interface DiscoveredModel {
  id: string;            // e.g. "deepseek-v4-flash"
  maxInputTokens: number;
  maxOutputTokens: number;
  thinkingEnabled: boolean;
  searchEnabled: boolean;
}

interface ModelConfig {
  model_type?: string;
  name?: string;
  // DeepSeek reports the input budget in CHARACTERS (input_character_limit),
  // not tokens. We convert to tokens using ~3.5 chars/token (same heuristic as
  // telemetry.ts) so the rest of the pipeline stays in token-space.
  input_character_limit?: number;
  max_input_tokens?: number; // fallback, if ever provided
  think_feature?: Record<string, unknown>;
  search_feature?: Record<string, unknown>;
}

const CACHE_TTL_MS = Number(process.env.DEEPSPROXY_MODELS_REFRESH_MS || 60 * 60 * 1000); // 1h default

// ~3.5 characters per token, matching the telemetry heuristic.
const CHARS_PER_TOKEN = 3.5;

// Safety cap on any single discovered context limit (tokens). Protects against
// a corrupted/absurd `input_character_limit` re-inflating the context and
// sending oversized prompts upstream. Default 1M tokens is above any real
// DeepSeek model, so it never clips a legitimate value.
const MAX_DISCOVERED_TOKENS = Number(process.env.DEEPSPROXY_MODELS_MAX_TOKENS || 1_000_000);

let modelsCache: DiscoveredModel[] | null = null;
let modelsCacheAt = 0;

function toModelId(modelType: string): string {
  // Map DeepSeek model_type to the OpenAI-compatible IDs we expose.
  // DeepSeek uses types like "default", "expert", "vision". We expose them as
  // deepseek-v4-flash / deepseek-v4-pro (+ -thinking variants) to keep the
  // existing public API stable. Unknown types fall back to their raw type.
  switch (modelType) {
    case 'default': return 'deepseek-v4-flash';
    case 'expert': return 'deepseek-v4-pro';
    case 'vision': return 'deepseek-vision';
    default: return modelType;
  }
}

function expandVariants(m: ModelConfig): DiscoveredModel[] {
  const baseId = toModelId(m.model_type || 'default');
  // Prefer the explicit token cap; otherwise convert the character limit to tokens.
  const fromChars = m.input_character_limit ? Math.floor(m.input_character_limit / CHARS_PER_TOKEN) : 0;
  const maxIn = Math.min(m.max_input_tokens || fromChars || 64_000, MAX_DISCOVERED_TOKENS);
  const maxOut = 8_000;
  const thinking = !!(m.think_feature && m.think_feature.enabled !== false);
  const search = !!(m.search_feature && m.search_feature.enabled !== false);

  const out: DiscoveredModel[] = [];
  if (thinking) {
    out.push({ id: `${baseId}-thinking`, maxInputTokens: maxIn, maxOutputTokens: maxOut, thinkingEnabled: true, searchEnabled: search });
  }
  out.push({ id: baseId, maxInputTokens: maxIn, maxOutputTokens: maxOut, thinkingEnabled: false, searchEnabled: search });
  return out;
}

/**
 * Fetch the real model capabilities from DeepSeek. Falls back to null (and the
 * caller keeps its existing caps) if the request fails.
 */
export async function discoverModels(force = false): Promise<DiscoveredModel[]> {
  if (!force && modelsCache && Date.now() - modelsCacheAt < CACHE_TTL_MS) {
    return modelsCache;
  }

  try {
    const { headers } = await getDeepSeekHeaders(false);
    const url = `https://chat.deepseek.com/api/v0/client/settings?did=${crypto.randomUUID()}&scope=model`;
    const init: RequestInit = {
      headers: {
        'accept': '*/*',
        'authorization': headers['authorization'] || '',
        'cookie': headers['cookie'] || '',
        'x-client-version': '2.0.0',
        'x-client-platform': 'web',
      },
    };
    // Same TLS-relaxation as the completion fetch: work around intermittent
    // SELF_SIGNED_CERT_IN_CHAIN errors caused by local SSL-inspection middleware.
    let res: Response;
    if (process.env.DEEPSPROXY_INSECURE_TLS === 'true' && process.env.TEST_MOCK_PLAYWRIGHT !== 'true') {
      const agent = new Agent({ connect: { rejectUnauthorized: false } });
      res = await undiciFetch(url, { ...init, dispatcher: agent } as any) as unknown as Response;
    } else {
      res = await fetch(url, init);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn(`[models] /client/settings returned ${res.status}: ${errText.slice(0, 300)}`);
      return modelsCache || [];
    }

    const rawText = await res.text();
    let data: any = null;
    try { data = JSON.parse(rawText); } catch {}
    if (!data) {
      console.warn(`[models] /client/settings returned non-JSON body: ${rawText.slice(0, 300)}`);
      return modelsCache || [];
    }
    // Real shape (verified 2026-10-19):
    //   data.biz_data.settings.model_configs = { id, value: [{ model_type, name,
    //     input_character_limit, think_feature, search_feature, ... }] }
    const rawConfigs: any =
      data?.data?.biz_data?.settings?.model_configs ||
      data?.model_configs ||
      data?.data?.model_configs ||
      data?.data?.biz_data?.model_configs ||
      data?.data?.model_config ||
      null;
    const configs: ModelConfig[] = Array.isArray(rawConfigs)
      ? rawConfigs
      : (Array.isArray(rawConfigs?.value) ? rawConfigs.value : []);
    if (!Array.isArray(configs) || configs.length === 0) {
      // Debug dump to discover the real response shape on the first miss.
      try {
        const pretty = JSON.stringify(data?.data ?? data).slice(0, 1500);
        console.warn(`[models] No model_configs found in /client/settings. Top keys: ${Object.keys(data).join(',')}. data keys: ${Object.keys(data?.data ?? {}).join(',')}. sample: ${pretty}`);
      } catch (e) {
        console.warn(`[models] No model_configs found in /client/settings. Top keys: ${Object.keys(data).join(',')}`);
      }
      return modelsCache || [];
    }

    const discovered = configs.flatMap(expandVariants);
    modelsCache = discovered;
    modelsCacheAt = Date.now();
    console.log(`[models] Discovered ${discovered.length} models from DeepSeek.`);
    for (const m of discovered) {
      console.log(`[models]   ${m.id}: max_input=${m.maxInputTokens} max_output=${m.maxOutputTokens} thinking=${m.thinkingEnabled} search=${m.searchEnabled}`);
    }
    return discovered;
  } catch (err: any) {
    console.warn('[models] Failed to discover models (keeping existing caps):', err?.message || err);
    return modelsCache || [];
  }
}

export function getDiscoveredModels(): DiscoveredModel[] {
  return modelsCache || [];
}
