import { getSettings } from "./shared.js";

// Keep the connection token out of content-script storage access.
chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});

let creating;
let starting = false;
async function offscreenExists() {
  return (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length > 0;
}
async function ensureOffscreen() {
  if (await offscreenExists()) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: "offscreen.html", reasons: ["BLOBS"],
      justification: "在后台将复制的媒体分片组装为 Blob，并发送到本机字幕服务。",
    }).finally(() => { creating = null; });
  }
  await creating;
}
async function toOffscreen(type, data = {}) {
  return chrome.runtime.sendMessage({ target: "offscreen", type, ...data });
}
async function state() {
  return await offscreenExists() ? await toOffscreen("STATE") : { active: false };
}
async function toTab(tabId, message) {
  try { return await chrome.tabs.sendMessage(tabId, message); } catch { return null; }
}
async function start(tabId) {
  if (starting) throw new Error("正在启动，请稍候。");
  starting = true;
  try {
    const current = await state();
    if (current.active) throw new Error("已有标签页正在翻译，请先停止。");
    const tab = await chrome.tabs.get(tabId);
    const url = new URL(tab.url);
    if (url.hostname !== "www.youtube.com" || !/^\/(watch|live\/|shorts\/)/.test(url.pathname)) {
      throw new Error("请先打开一个 YouTube 视频或直播页面。");
    }
    const settings = await getSettings();
    if (!settings.token) throw new Error("请先打开设置，填写本机连接口令。");
    if (!chrome.offscreen?.createDocument) {
      throw new Error("当前 Edge 不支持后台字幕处理，请更新 Edge。");
    }
    // Re-injection is idempotent and also covers tabs opened before installation.
    await chrome.scripting.executeScript({ target: { tabId }, files: ["sync-core.js", "content.js"] });
    const clock = await toTab(tabId, { type: "CLOCK" });
    if (!clock?.hasVideo) throw new Error("未找到播放器，请等待视频加载完成。");
    await ensureOffscreen();
    const result = await toOffscreen("START", { tabId, settings });
    if (!result?.ok) throw new Error(result?.error || "无法启动字幕处理。");
    const { fontSize, showOriginal, bottom } = settings;
    const overlay = await toTab(tabId, { type: "SESSION", active: true, settings: { fontSize, showOriginal, bottom } });
    if (!overlay?.ok) { await stop(); throw new Error("字幕画面初始化失败，请刷新视频页后重试。"); }
    return { ok: true };
  } finally { starting = false; }
}
async function stop(errorText = "") {
  if (await offscreenExists()) await toOffscreen("STOP", { errorText });
  await chrome.action.setBadgeText({ text: "" });
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.target === "offscreen" || sender.id !== chrome.runtime.id) return;
  const handle = async () => {
    // A page content script can relay playback events, but cannot start captures
    // or retrieve the locally stored token/settings.
    if (sender.tab) {
      if (message.type === "DISCONTINUITY") {
        if (await offscreenExists()) await toOffscreen("RESET", { tabId: sender.tab.id });
        return { ok: true };
      }
      return { ok: false };
    }
    switch (message.type) {
      case "START": return start(message.tabId);
      case "STOP": return stop();
      case "STATE": return state();
      case "OPTIONS": await chrome.runtime.openOptionsPage(); return { ok: true };
      case "CLOCK": return toTab(message.tabId, { type: "CLOCK" });
      case "MEDIA_SNAPSHOT": return toTab(message.tabId, { type: "MEDIA_SNAPSHOT", version: message.version, time: message.time });
      case "SUBTITLE":
        return toTab(message.tabId, { type: "SUBTITLE", ...message.data });
      case "SESSION_ENDED":
        await toTab(message.tabId, { type: "SESSION", active: false });
        await chrome.action.setBadgeText({ text: "" });
        return { ok: true };
      case "STATUS":
        await chrome.action.setBadgeBackgroundColor({ color: message.error ? "#c14747" : "#269b83" });
        await chrome.action.setBadgeText({ text: message.active ? (message.error ? "!" : "ON") : "" });
        await toTab(message.tabId, { type: "STATUS", text: message.text });
        return { ok: true };
      default: return { ok: false };
    }
  };
  handle().then(respond).catch(error => respond({ ok: false, error: error.message }));
  return true;
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const current = await state();
  if (current.tabId === tabId) await stop();
});
chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  if (change.status !== "loading" && !change.url) return;
  const current = await state();
  if (current.active && current.tabId === tabId) {
    // Stop on full navigation. YouTube's client-side navigation uses RESET.
    if (change.status === "loading") await stop();
    else await toOffscreen("RESET", { tabId });
  }
});
