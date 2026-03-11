const KEY_PREFIX = "ot_chat_apikey_";
const PROVIDER_KEY = "ot_chat_provider";

export function loadApiKey(provider: string): string {
  return localStorage.getItem(KEY_PREFIX + provider) ?? "";
}

export function saveApiKey(provider: string, key: string): void {
  if (key) {
    localStorage.setItem(KEY_PREFIX + provider, key);
  } else {
    localStorage.removeItem(KEY_PREFIX + provider);
  }
}

export function loadProviderChoice(): string {
  return localStorage.getItem(PROVIDER_KEY) ?? "anthropic";
}

export function saveProviderChoice(provider: string): void {
  localStorage.setItem(PROVIDER_KEY, provider);
}
