import { api, getSettings } from "./shared.js";

const $ = id => document.getElementById(id);
const languages = { auto: "自动检测", en: "英语", zh: "简体中文", cht: "繁体中文", ja: "日语", jp: "日语", ko: "韩语", kor: "韩语", fr: "法语", fra: "法语", de: "德语", es: "西班牙语", spa: "西班牙语", ru: "俄语" };
let active = false, settings, busy = false, serviceReady = false;
function feedback(text, error = false) { $("feedback").textContent = text; $("feedback").classList.toggle("error", error); }
function renderButton() {
  $("toggle").textContent = busy ? "正在处理…" : active ? "停止字幕翻译" : "开始字幕翻译";
  $("toggle").className = active ? "secondary stop" : "primary";
  $("toggle").disabled = busy || (!active && !serviceReady);
}
async function refresh() {
  if (busy) return;
  try {
    const state = await chrome.runtime.sendMessage({ type: "STATE" });
    active = Boolean(state?.active);
    if (state?.text && (active || state.error)) feedback(state.text, state.error);
    renderButton();
  } catch (error) { feedback(error.message, true); }
}
async function initialize() {
  settings = await getSettings();
  $("languages").textContent = `${languages[settings.language] || settings.language} → ${languages[settings.target] || settings.target}`;
  $("chunk").textContent = `${settings.chunkSeconds} 秒`;
  $("delay").textContent = "原生播放 · 字幕缓存 1 分钟";
  await refresh();
  try {
    const data = await api("/check", settings, { signal: AbortSignal.timeout(5000) });
    serviceReady = true;
    $("dot").className = "dot ready";
    $("connection").textContent = data.translation_ready ? "已连接，可以开始" : "已连接 · 需要翻译配置";
    $("connection-detail").textContent = data.model_ready ? "Whisper 已就绪" : "首次启动需要准备模型，可能需要数分钟";
    $("engine").textContent = data.device === "cuda" ? "NVIDIA GPU" : "CPU";
    if (!data.translation_ready) feedback("请在设置中填写百度翻译凭据；也可先测试原文识别。");
  } catch (error) {
    $("dot").className = "dot error";
    $("connection").textContent = "连接尚未就绪";
    $("connection-detail").textContent = error.status === 401 ? error.message : "请先运行 start.ps1，并在设置中填写本机连接口令。";
  }
  renderButton();
}
$("options").addEventListener("click", () => chrome.runtime.sendMessage({ type: "OPTIONS" }));
$("toggle").addEventListener("click", async () => {
  busy = true; renderButton();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const response = await chrome.runtime.sendMessage({ type: active ? "STOP" : "START", tabId: tab?.id });
    if (!response?.ok) throw new Error(response?.error || "无法启动字幕翻译。");
    active = !active;
    feedback(active ? "正在预读音频分片，原声由 YouTube 播放。" : "已停止");
  } catch (error) { feedback(error.message, true); }
  finally { busy = false; renderButton(); }
});
initialize().catch(error => feedback(error.message, true));
setInterval(refresh, 1500);
