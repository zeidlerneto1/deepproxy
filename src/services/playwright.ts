/*
 * File: playwright.ts
 * Project: deepsproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 * 
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';

let context: BrowserContext | null = null;
export let activePage: Page | null = null;
let currentHeaders: Record<string, string> = {};

// ─── Session/header cache ───────────────────────────────────────────────────────
// Capturing PoW/headers via Playwright means navigating the browser, waiting for
// the chat input and intercepting a completion request. Doing that on EVERY request
// is slow and fragile. Instead we cache the captured session and reuse it until it
// expires (or until a request signals it is stale), which dramatically cuts browser
// churn and the associated intermittent failures.

interface SessionCache {
  headers: Record<string, string>;
  chatSessionId: string;
  parentMessageId: number | null;
  capturedAt: number; // ms epoch when the cache was last refreshed
}

function headersFile(): string {
  return process.env.DEEPSPROXY_HEADERS_FILE || path.join(path.resolve('deepseek_profile'), 'session_headers.json');
}

function headersTtlMs(): number {
  return Number(process.env.DEEPSPROXY_HEADERS_TTL_MS || 5 * 60 * 1000); // default 5 min
}

let sessionCache: SessionCache | null = null;
let sessionInvalidated = false;

// Exported for unit tests.
export function loadSessionCache(): SessionCache | null {
  if (sessionCache) return sessionCache;
  const file = headersFile();
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (raw && raw.headers && typeof raw.capturedAt === 'number') {
        sessionCache = raw as SessionCache;
        currentHeaders = raw.headers;
      }
    }
  } catch (err: any) {
    console.warn('[playwright] Failed to load session cache:', err?.message || err);
  }
  return sessionCache;
}

function saveSessionCache(cache: SessionCache): void {
  sessionCache = cache;
  currentHeaders = cache.headers;
  try {
    const file = headersFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (err: any) {
    console.warn('[playwright] Failed to persist session cache:', err?.message || err);
  }
}

// Exported for unit tests.
export function isCacheFresh(cache: SessionCache): boolean {
  return Date.now() - cache.capturedAt < headersTtlMs();
}

// Exported for unit tests.
export function sessionCacheForTest(): SessionCache | null {
  return sessionCache;
}

/**
 * Force the next getDeepSeekHeaders call to re-capture (navigate + intercept)
 * even if a fresh cache exists. Used when a request fails with a stale PoW/
 * session error.
 */
export function invalidateSession(): void {
  sessionInvalidated = true;
}

export async function initPlaywright(headless = true) {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (context) {
    return;
  }

  const profilePath = path.resolve('deepseek_profile');

  // Use an already-installed browser via a Playwright channel when available
  // (e.g. "chrome" for system Chrome, "msedge" for Edge). This avoids the large
  // bundled Chromium download. Falls back to the bundled browser when unset/empty.
  const channel = process.env.PLAYWRIGHT_CHANNEL || undefined;
  // Mirror the TLS-relaxation from deepseek.ts: when DEEPSPROXY_INSECURE_TLS is
  // set, also let the browser ignore invalid HTTPS certs. This is required inside
  // containers (the bundled Chromium has no host CA store) when local SSL-
  // inspection injects a self-signed cert into the chain.
  const ignoreHTTPSErrors = process.env.DEEPSPROXY_INSECURE_TLS === 'true';

  context = await chromium.launchPersistentContext(profilePath, {
    headless,
    ignoreHTTPSErrors,
    ...(channel ? { channel } : {}),
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--exclude-switches=enable-automation',
      '--disable-infobars',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  // Keep an active page to fetch PoW headers on demand
  activePage = await context.newPage();
}

export async function closePlaywright() {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (context) {
    await context.close();
    context = null;
    activePage = null;
  }
}

/**
 * Ensures the session is valid and extracts headers, PoW, and session ID.
 */
export async function getDeepSeekHeaders(forceNew = false): Promise<{ headers: Record<string, string>, chatSessionId: string, parentMessageId: number | null }> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    // Generate a unique session ID if requested for testing isolation
    const mockSessionId = process.env.TEST_SESSION_ID || 'mock-session';
    return { headers: { authorization: 'Bearer MOCK' }, chatSessionId: mockSessionId, parentMessageId: null };
  }

  // Reuse a fresh cached session instead of re-navigating the browser. Only
  // re-capture when forced, when the cache has expired, or when a prior request
  // flagged the session as stale.
  const cached = loadSessionCache();
  if (!forceNew && !sessionInvalidated && cached && isCacheFresh(cached)) {
    return { headers: cached.headers, chatSessionId: cached.chatSessionId, parentMessageId: cached.parentMessageId };
  }
  // If we are re-capturing, clear the stale flag so the next request can reuse it.
  sessionInvalidated = false;

  if (!activePage) {
    throw new Error('Playwright not initialized');
  }

  // Navigate to deepseek chat. If forceNew is true or we're not on deepseek, go to home page.
  const currentUrl = activePage.url();
  const isOnDeepSeek = currentUrl.includes('chat.deepseek.com');
  const isOnSpecificChat = isOnDeepSeek && /\/chat\/\d+/.test(currentUrl);

  if (!isOnDeepSeek || forceNew || isOnSpecificChat) {
    await activePage.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded' });
  }

  // Wait for the chat input. Keep this timeout short: when DeepSeek shows an
  // account/login/suspension banner there is no input, and retrying the same
  // browser state just makes OpenAI clients look hung.
  const chatInputSelector = 'textarea, [role="textbox"], [contenteditable="true"]';
  const chatInputTimeoutMs = Number(process.env.DEEPSPROXY_CHAT_INPUT_TIMEOUT_MS || '8000');
  await activePage.waitForSelector(chatInputSelector, { timeout: chatInputTimeoutMs }).catch(async () => {
    const pageState = await activePage!.evaluate(() => {
      const fullBodyText = document.body?.innerText || '';
      const bodyText = fullBodyText.slice(0, 5000);
      const suspensionMatch = fullBodyText.match(/Due to violation of user policies, your account has been suspended until\s+([^\.\n]+)\.\s*If you have any questions, please Contact us\./i);
      const suspendedUntil = suspensionMatch?.[1]?.trim() || null;
      const suspensionOriginal = suspensionMatch?.[0]?.trim() || null;
      return {
        url: location.href,
        title: document.title,
        bodyText,
        textareaCount: document.querySelectorAll('textarea').length,
        inputCount: document.querySelectorAll('input, textarea, [role="textbox"], [contenteditable]').length,
        suspended: /suspended until|violation of user policies|account has been suspended/i.test(fullBodyText),
        suspendedUntil,
        suspensionOriginal,
        loginRequired: /log in|login|sign in|entrar/i.test(fullBodyText),
      };
    }).catch((e: any) => ({ evaluateError: e?.message || String(e) }));

    const state: any = pageState;
    if (state?.suspended) {
      const until = typeof state.suspendedUntil === 'string' && state.suspendedUntil.trim() ? state.suspendedUntil.trim() : '';
      const original = typeof state.suspensionOriginal === 'string' && state.suspensionOriginal.trim() ? state.suspensionOriginal.trim() : '';
      const detail = original || (until ? `Due to violation of user policies, your account has been suspended until ${until}.` : 'DeepSeek reported an account suspension.');
      throw new Error(`DeepSeek account is suspended; chat input is unavailable. Original DeepSeek message: ${detail}`);
    }
    if (state?.loginRequired) {
      throw new Error('DeepSeek login is required; chat input is unavailable.');
    }
    throw new Error('DeepSeek chat input unavailable; page did not expose an input box.');
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout waiting for PoW headers')), 30000);

    const routeHandler = async (route: any, request: any) => {
      clearTimeout(timeout);
      
      const reqHeaders = request.headers();
      let uiSessionId = '';
      let uiParentMessageId: number | null = null;

      const postData = request.postData();
      if (postData) {
        try {
          const payload = JSON.parse(postData);
          if (payload.chat_session_id) {
            uiSessionId = payload.chat_session_id;
          }
          if (payload.parent_message_id !== undefined) {
            uiParentMessageId = payload.parent_message_id;
          }
        } catch (e) {
          // ignore parsing error
        }
      }

      const extractedHeaders = {
        'x-ds-pow-response': reqHeaders['x-ds-pow-response'] || '',
        'x-hif-dliq': reqHeaders['x-hif-dliq'] || '',
        'x-hif-leim': reqHeaders['x-hif-leim'] || '',
        'authorization': reqHeaders['authorization'] || '',
        'cookie': reqHeaders['cookie'] || ''
      };

      currentHeaders = extractedHeaders;

      // Persist the freshly captured session so subsequent requests reuse it
      // instead of re-navigating the browser.
      saveSessionCache({
        headers: extractedHeaders,
        chatSessionId: uiSessionId,
        parentMessageId: uiParentMessageId,
        capturedAt: Date.now(),
      });

      // Abort to prevent polluting chat history
      await route.abort('aborted');
      
      // Cleanup route
      await activePage!.unroute('**/api/v0/chat/completion', routeHandler);

      resolve({ headers: extractedHeaders, chatSessionId: uiSessionId, parentMessageId: uiParentMessageId });
    };

    activePage!.route('**/api/v0/chat/completion', routeHandler).then(() => {
      // Trigger PoW generation by typing and hitting enter
      activePage!.fill('textarea', 'a').then(() => {
        activePage!.keyboard.press('Enter');
      });
    });
  });
}
