/*
 * File: deepseek.ts
 * Project: deepsproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 *
 * Last Modified: 2026-10-19
 * Modified By: kimi-cli integration
 * - Added optional TLS-relaxed fetch (DEEPSPROXY_INSECURE_TLS) to work around
 *   intermittent SELF_SIGNED_CERT_IN_CHAIN errors caused by local SSL-inspection
 *   middleware (antivirus/firewall) on the connection to chat.deepseek.com.
 */

import { getDeepSeekHeaders } from './playwright.ts';
import { Agent, fetch as undiciFetch } from 'undici';

// In-memory state to track the last message ID per session to avoid overwriting
// Use globalThis to ensure it survives module reloads in some test environments
const sessionStates: Record<string, number | null> = (globalThis as any)._sessionStates || {};
(globalThis as any)._sessionStates = sessionStates;

export function updateSessionParent(sessionId: string, parentId: number | null) {
  if (sessionId) {
    sessionStates[sessionId] = parentId;
  }
}

export interface DeepSeekPayload {
  chat_session_id?: string;
  parent_message_id?: number | null;
  model_type: string | null;
  prompt: string;
  ref_file_ids: string[];
  thinking_enabled: boolean;
  search_enabled: boolean;
  preempt: boolean;
}

/**
 * Fetch wrapper for the DeepSeek completion endpoint.
 *
 * When `DEEPSPROXY_INSECURE_TLS=true`, disables TLS certificate verification
 * for this connection only. This is a workaround for environments where local
 * SSL-inspection middleware (antivirus/firewall) intermittently injects a
 * self-signed cert into the chain, causing `SELF_SIGNED_CERT_IN_CHAIN` errors.
 * Use only in trusted networks.
 */
async function fetchDeepSeek(
  payload: DeepSeekPayload,
  headers: Record<string, string>
): Promise<Response> {
  const url = 'https://chat.deepseek.com/api/v0/chat/completion';
  const init: RequestInit = {
    method: 'POST',
    headers: {
      'accept': '*/*',
      'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      'authorization': headers['authorization'],
      'content-type': 'application/json',
      'origin': 'https://chat.deepseek.com',
      'x-ds-pow-response': headers['x-ds-pow-response'],
      'x-hif-dliq': headers['x-hif-dliq'],
      'x-hif-leim': headers['x-hif-leim'],
      'x-app-version': '2.0.0',
      'x-client-locale': 'pt_BR',
      'x-client-platform': 'web',
      'x-client-version': '2.0.0'
    },
    body: JSON.stringify(payload),
  };

  if (process.env.DEEPSPROXY_INSECURE_TLS === 'true') {
    // Relax TLS verification only for the DeepSeek upstream connection.
    const agent = new Agent({
      connect: { rejectUnauthorized: false },
    });
    // undici's fetch accepts a `dispatcher` option; cast through `any` to bridge
    // the (mostly identical) RequestInit typings between Node's global fetch and undici.
    return undiciFetch(url, { ...init, dispatcher: agent } as any) as unknown as Promise<Response>;
  }

  return fetch(url, init);
}

export async function createDeepSeekStream(
  prompt: string,
  enableThinking: boolean,
  isProModel: boolean = false,
  forcedParentId?: number | null
): Promise<{ stream: ReadableStream, headers: Record<string, string>, uiSessionId: string }> {
  // Obtain fresh headers/PoW from Playwright
  // If forcedParentId is null, it means we are explicitly starting a new session
  const { headers, chatSessionId, parentMessageId } = await getDeepSeekHeaders(forcedParentId === null);

  // Determine the actual parent ID:
  // 1. If forcedParentId is provided (even if null), use it.
  // 2. If tracked parent ID is available for this session, use it.
  // 3. Fallback to Playwright's state.
  let actualParentId: number | null = parentMessageId;

  if (forcedParentId !== undefined) {
    actualParentId = forcedParentId;
  } else if (chatSessionId && sessionStates[chatSessionId] !== undefined) {
    actualParentId = sessionStates[chatSessionId];
  }

  const payload: DeepSeekPayload = {
    chat_session_id: chatSessionId || undefined,
    parent_message_id: actualParentId,
    model_type: isProModel ? 'expert' : null,
    prompt: prompt,
    ref_file_ids: [],
    thinking_enabled: enableThinking,
    search_enabled: true,
    preempt: false
  };

  const response = await fetchDeepSeek(payload, headers);

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Failed to fetch from DeepSeek: ${response.status} ${response.statusText} - ${errText}`);
  }

  return { stream: response.body, headers, uiSessionId: chatSessionId };
}
