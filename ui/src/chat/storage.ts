/*
 * Copyright 2026 OpenTrace Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const KEY_PREFIX = 'ot_chat_apikey_';
const PROVIDER_KEY = 'ot_chat_provider';
const MODEL_PREFIX = 'ot_chat_model_';
const LOCAL_URL_KEY = 'ot_chat_local_url';
const HISTORY_ENABLED_KEY = 'ot_chat_history_enabled';

export function loadApiKey(provider: string): string {
  return localStorage.getItem(KEY_PREFIX + provider) ?? '';
}

export function saveApiKey(provider: string, key: string): void {
  if (key) {
    localStorage.setItem(KEY_PREFIX + provider, key);
  } else {
    localStorage.removeItem(KEY_PREFIX + provider);
  }
}

export function loadProviderChoice(): string {
  return localStorage.getItem(PROVIDER_KEY) ?? 'gemini';
}

export function saveProviderChoice(provider: string): void {
  localStorage.setItem(PROVIDER_KEY, provider);
}

export function loadModelChoice(provider: string): string | null {
  return localStorage.getItem(MODEL_PREFIX + provider);
}

export function saveModelChoice(provider: string, model: string): void {
  localStorage.setItem(MODEL_PREFIX + provider, model);
}

export function loadLocalUrl(): string {
  return (
    localStorage.getItem(LOCAL_URL_KEY) ??
    `${window.location.protocol}//${window.location.hostname}:11434`
  );
}

export function saveLocalUrl(url: string): void {
  if (url) {
    localStorage.setItem(LOCAL_URL_KEY, url);
  } else {
    localStorage.removeItem(LOCAL_URL_KEY);
  }
}

export function loadChatHistoryEnabled(): boolean {
  return localStorage.getItem(HISTORY_ENABLED_KEY) === 'true';
}

export function saveChatHistoryEnabled(enabled: boolean): void {
  localStorage.setItem(HISTORY_ENABLED_KEY, String(enabled));
}
