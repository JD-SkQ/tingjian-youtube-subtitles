import { api, getSettings } from "./shared.js";

const $ = id => document.getElementById(id);
const fields = ["token", "language", "target", "chunkSeconds", "fontSize", "bottom"];
function show(id, text, error = false) { $(id).textContent = text; $(id).classList.toggle("error", error); }
function readForm() {
  return { token: $("token").value.trim(), language: $("language").value, target: $("target").value,
    chunkSeconds: Number($("chunkSeconds").value), fontSize: Number($("fontSize").value),
    bottom: Number($("bottom").value), showOriginal: $("showOriginal").checked };
}
async function save() {
  await chrome.storage.local.set({ settings: readForm() });
  show("save-status", "设置已保存。重新启动字幕翻译后生效。");
  show("connection-status", "本机连接口令已保存。");
}
async function task(buttonId, outputId, callback) {
  const button = $(buttonId);
  button.disabled = true;
  try { await callback(); }
  catch (error) { show(outputId, error.message === "Failed to fetch" ? "连接失败，请运行 start.ps1，并确认服务窗口没有报错。" : error.message, true); }
  finally { button.disabled = false; }
}
$("save").addEventListener("click", () => task("save", "connection-status", save));
$("save-all").addEventListener("click", () => task("save-all", "save-status", save));
$("check").addEventListener("click", () => task("check", "connection-status", async () => {
  show("connection-status", "正在检测…");
  const data = await api("/check", readForm(), { signal: AbortSignal.timeout(5000) });
  show("connection-status", `连接成功 · ${data.model} · ${data.device} / ${data.compute_type}\n模型：${data.model_ready ? "已就绪" : "尚未准备"} · 百度翻译：${data.translation_ready ? "已配置" : "未配置"}${data.model_error ? "\n" + data.model_error : ""}`);
}));
$("warmup").addEventListener("click", () => task("warmup", "connection-status", async () => {
  show("connection-status", "正在下载或加载模型，首次可能需要数分钟。请保持此页面和本机服务打开…");
  await api("/warmup", readForm(), { method: "POST", signal: AbortSignal.timeout(900000) });
  show("connection-status", "Whisper 模型已就绪，可以打开 YouTube 开始翻译。");
}));
$("credentials").addEventListener("click", () => task("credentials", "credentials-status", async () => {
  if (!$("app-id").value.trim() || !$("secret").value.trim()) throw new Error("请填写 APP ID 和密钥。");
  show("credentials-status", "正在验证百度翻译凭据…");
  const data = await api("/credentials", readForm(), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: $("app-id").value.trim(), secret: $("secret").value.trim() }),
    signal: AbortSignal.timeout(60000),
  });
  $("secret").value = "";
  show("credentials-status", `凭据已保存到本机，测试译文：${data.test_translation}`);
}));
getSettings().then(settings => {
  for (const field of fields) $(field).value = settings[field];
  $("showOriginal").checked = settings.showOriginal;
}).catch(error => show("save-status", error.message, true));
