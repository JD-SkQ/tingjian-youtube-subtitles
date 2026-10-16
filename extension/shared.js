export const DEFAULTS = Object.freeze({
  token: "", language: "auto", target: "zh", chunkSeconds: 4,
  fontSize: 26, showOriginal: true, bottom: 12,
});
export const BASE_URL = "http://127.0.0.1:8765";
export async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  const value = { ...DEFAULTS, ...settings };
  if (![2, 4, 6, 8].includes(value.chunkSeconds)) value.chunkSeconds = 4;
  if (![20, 26, 32, 40].includes(value.fontSize)) value.fontSize = 26;
  if (![6, 12, 20, 30].includes(value.bottom)) value.bottom = 12;
  delete value.playbackDelay; // Migrate 0.2.0 settings; native playback is always used.
  if (!["auto", "en", "ja", "ko", "zh", "fr", "de", "es", "ru"].includes(value.language)) value.language = "auto";
  if (!["zh", "cht", "en", "jp", "kor", "fra", "de", "spa", "ru"].includes(value.target)) value.target = "zh";
  return value;
}
export async function api(path, settings, options = {}) {
  const response = await fetch(BASE_URL + path, {
    ...options,
    headers: { Authorization: `Bearer ${settings.token}`, ...options.headers },
  });
  let data;
  try { data = await response.json(); } catch { throw new Error(`本机服务返回了无效响应（${response.status}）`); }
  if (!response.ok) {
    const error = new Error(typeof data.detail === "string" ? data.detail : `请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return data;
}
