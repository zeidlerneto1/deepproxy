import test from 'node:test';
import assert from 'node:assert';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';
process.env.DEEPSPROXY_HEADERS_TTL_MS = '1000';

import { isCacheFresh } from './services/playwright.ts';
import { applyDiscoveredModels, getContextLength } from './services/telemetry.ts';
import { discoverModels } from './services/models.ts';
import { isSessionError } from './services/deepseek.ts';

test('session cache: isCacheFresh respects the TTL', () => {
  // Fresh (captured now) -> true
  assert.strictEqual(isCacheFresh({ headers: {}, chatSessionId: 's', parentMessageId: null, capturedAt: Date.now() }), true);
  // Expired (captured > TTL ago) -> false
  assert.strictEqual(isCacheFresh({ headers: {}, chatSessionId: 's', parentMessageId: null, capturedAt: Date.now() - 2000 }), false);
});

test('telemetry: applyDiscoveredModels overrides the manual cap', () => {
  // Apply a discovered pro limit (e.g. 40k tokens) and verify getContextLength uses it.
  applyDiscoveredModels([{ id: 'deepseek-v4-pro', maxInputTokens: 40_000 }]);
  const contextTokens = getContextLength('deepseek-v4-pro');
  assert.ok(Math.abs(contextTokens - 40_000) <= 1, `Expected ~40000 tokens, got ${contextTokens}`);
});

test('session error detection flags stale-session failures', () => {
  assert.strictEqual(isSessionError('DeepSeek account is suspended'), true);
  assert.strictEqual(isSessionError('DeepSeek login is required'), true);
  assert.strictEqual(isSessionError('Timeout waiting for PoW headers'), true);
  assert.strictEqual(isSessionError('DeepSeek chat input unavailable'), true);
  assert.strictEqual(isSessionError('Failed to fetch from DeepSeek: 401 Unauthorized'), true);
  // Generic network errors are NOT session errors (so retry reuses the cache).
  assert.strictEqual(isSessionError('DeepSeek fetch failed: self-signed certificate in certificate chain'), false);
  assert.strictEqual(isSessionError('DeepSeek fetch failed: fetch failed'), false);
});

test('discoverModels: parses /client/settings into model variants', async () => {
  const restore = (() => {
    const original = globalThis.fetch;
    globalThis.fetch = async (input: any, init?: any) => {
      const urlStr = typeof input === 'string' ? input : input.url;
      if (urlStr.includes('/api/v0/client/settings')) {
        return new Response(JSON.stringify({
          code: 0,
          msg: '',
          data: {
            biz_code: 0,
            biz_msg: '',
            biz_data: {
              settings: {
                model_configs: {
                  id: 123,
                  value: [
                    { model_type: 'default', name: 'Instant', input_character_limit: 224000, think_feature: { enabled: true }, search_feature: { enabled: false } },
                    { model_type: 'expert', name: 'Pro', input_character_limit: 70000, think_feature: { enabled: true }, search_feature: { enabled: true } },
                  ],
                },
              },
            },
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return original(input, init);
    };
    return () => { globalThis.fetch = original; };
  })();

  try {
    const models = await discoverModels(true);
    const ids = models.map(m => m.id).sort();
    assert.ok(ids.includes('deepseek-v4-flash'), `Expected flash variant, got ${JSON.stringify(ids)}`);
    assert.ok(ids.includes('deepseek-v4-flash-thinking'), `Expected flash-thinking variant, got ${JSON.stringify(ids)}`);
    assert.ok(ids.includes('deepseek-v4-pro'), `Expected pro variant, got ${JSON.stringify(ids)}`);
    assert.ok(ids.includes('deepseek-v4-pro-thinking'), `Expected pro-thinking variant, got ${JSON.stringify(ids)}`);
    const pro = models.find(m => m.id === 'deepseek-v4-pro');
    assert.strictEqual(pro?.maxInputTokens, 20000);
  } finally {
    restore();
  }
});
