"""Isolated browser checks with simulated extension APIs; no user browser profile."""
import functools
import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "test-results"

MOCK = r"""
window.__stored = {};
window.__messages = [];
window.__listeners = [];
window.chrome = {
  storage: {local: {
    get: async () => ({settings: {token:'test-local-token', language:'auto', target:'zh', chunkSeconds:4, fontSize:26, showOriginal:true, bottom:12, playbackDelay:10}}),
    set: async data => { window.__stored = data; }
  }},
  tabs: {query: async () => [{id:7, url:'https://www.youtube.com/watch?v=test'}]},
  runtime: {
    id:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    onMessage:{addListener: callback => window.__listeners.push(callback)},
    sendMessage:async message => {
      window.__messages.push(message);
      if(message.type==='STATE') return {active:window.__active || false, text:window.__active ? '正在聆听' : '尚未启动'};
      if(message.type==='START') window.__active=true;
      if(message.type==='STOP') window.__active=false;
      return {ok:true};
    }
  }
};
window.__deliver = message => new Promise(resolve => {
  for(const listener of window.__listeners) listener(message, {id:chrome.runtime.id}, resolve);
});
"""


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def run():
    OUTPUT.mkdir(exist_ok=True)
    handler = functools.partial(QuietHandler, directory=str(ROOT / "extension"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}"
    errors = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1100, "height": 1500}, device_scale_factor=1)
            context.add_init_script(MOCK)
            health = {"ok": True, "model": "large-v3-turbo", "device": "cuda", "compute_type": "int8_float16",
                      "model_ready": True, "translation_ready": True, "model_error": None}

            def api_route(route):
                path = route.request.url.split(":8765")[-1]
                data = {"ok": True, "test_translation": "你好"} if path == "/credentials" else health
                route.fulfill(status=200, content_type="application/json", body=json.dumps(data),
                              headers={"Access-Control-Allow-Origin": "*"})

            context.route("http://127.0.0.1:8765/**", api_route)
            options = context.new_page()
            options.on("pageerror", lambda error: errors.append(str(error)))
            options.goto(base + "/options.html")
            options.get_by_role("button", name="检测连接", exact=True).click()
            options.locator("#connection-status").filter(has_text="连接成功").wait_for()
            options.locator("#language").select_option("en")
            options.locator("#chunkSeconds").select_option("6")
            options.locator("#showOriginal").uncheck()
            options.get_by_role("button", name="保存全部设置", exact=True).click()
            saved = options.evaluate("window.__stored.settings")
            assert saved["language"] == "en" and saved["chunkSeconds"] == 6 and saved["showOriginal"] is False
            assert "playbackDelay" not in saved
            options.get_by_role("button", name="验证并保存翻译凭据").click()
            assert "请填写" in options.locator("#credentials-status").inner_text()
            options.locator("#app-id").fill("test-app")
            options.locator("#secret").fill("test-baidu-secret")
            options.get_by_role("button", name="验证并保存翻译凭据").click()
            options.locator("#credentials-status").filter(has_text="凭据已保存").wait_for()
            assert options.locator("#secret").input_value() == ""
            assert "secret" not in options.evaluate("JSON.stringify(window.__stored)")
            options.get_by_role("button", name="准备模型", exact=True).click()
            options.locator("#connection-status").filter(has_text="模型已就绪").wait_for()
            options.screenshot(path=str(OUTPUT / "options.png"), full_page=True)

            popup = context.new_page()
            popup.on("pageerror", lambda error: errors.append(str(error)))
            popup.set_viewport_size({"width": 370, "height": 590})
            popup.goto(base + "/popup.html")
            popup.get_by_text("已连接，可以开始").wait_for()
            popup.screenshot(path=str(OUTPUT / "popup.png"), full_page=True)
            popup.get_by_role("button", name="开始字幕翻译", exact=True).click()
            popup.get_by_role("button", name="停止字幕翻译", exact=True).wait_for()
            popup.get_by_role("button", name="停止字幕翻译", exact=True).click()
            popup.get_by_role("button", name="开始字幕翻译", exact=True).wait_for()

            player = context.new_page()
            player.add_init_script("""const attach = Element.prototype.attachShadow;
              Element.prototype.attachShadow = function(options) { const root = attach.call(this, options); window.__shadow = root; return root; };""")
            context.route("https://www.youtube.com/watch?*", lambda route: route.fulfill(content_type="text/html", body="""
              <html><body style='margin:0;background:#101824;color:white;font-family:Arial'>
              <div id='movie_player' class='html5-video-player' style='position:relative;width:960px;height:540px;margin:50px auto;background:linear-gradient(145deg,#182f49,#101420)'>
              <div style='padding:45px;color:#a8c8df'>ISOLATED PLAYER TEST · 模拟播放器</div><video class='html5-main-video'></video></div></body></html>"""))
            player.goto("https://www.youtube.com/watch?v=test")
            player.evaluate("""() => {const v=document.querySelector('video'); Object.defineProperty(v,'paused',{value:false,configurable:true});}""")
            player.add_script_tag(path=str(ROOT / "extension/sync-core.js"))
            player.add_script_tag(path=str(ROOT / "extension/content.js"))
            player.evaluate("window.__deliver({type:'SESSION',active:true,settings:{fontSize:26,showOriginal:true,bottom:12}})")
            clock = player.evaluate("window.__deliver({type:'CLOCK'})")
            subtitle = {"type": "SUBTITLE", "revision": clock["revision"], "videoId": "test", "cues": [{"start": 0, "end": 3, "text": "Language opens a window to the world.", "translation": "语言，为你打开一扇看世界的窗。"}]}
            assert player.evaluate("m=>window.__deliver(m)", subtitle)["ok"]
            assert player.evaluate("window.__shadow.querySelector('.translation').textContent") == subtitle["cues"][0]["translation"]
            player.screenshot(path=str(OUTPUT / "player.png"), full_page=True)
            # Seek preserves useful cached cues but rejects obsolete in-flight results.
            player.evaluate("document.querySelector('video').dispatchEvent(new Event('seeking'))")
            assert not player.evaluate("window.__shadow.querySelector('.translation').hidden")
            assert not player.evaluate("m=>window.__deliver(m)", subtitle)["ok"]
            new_clock = player.evaluate("window.__deliver({type:'CLOCK'})")
            subtitle["revision"] = new_clock["revision"]
            assert player.evaluate("m=>window.__deliver(m)", subtitle)["ok"]
            # API text is textContent: markup cannot execute in the player.
            subtitle["cues"][0]["translation"] = '<img src=x onerror="window.__xss=true">'
            assert player.evaluate("m=>window.__deliver(m)", subtitle)["ok"]
            assert player.evaluate("window.__shadow.querySelectorAll('img').length") == 0
            # A result arriving 50 ms before its timestamp end must not flash
            # and disappear on the next render tick.
            player.evaluate("document.querySelector('video').currentTime=1.95")
            late_clock=player.evaluate("window.__deliver({type:'CLOCK'})")
            player.evaluate("m=>window.__deliver(m)", {**late_clock,"type":"SUBTITLE",
                "range":{"start":0,"end":4},"cues":[{"start":1,"end":2,"text":"late readable","translation":"晚到的字幕仍可阅读"}]})
            player.evaluate("document.querySelector('video').currentTime=2.05")
            player.wait_for_timeout(200)
            assert player.evaluate("window.__shadow.querySelector('.translation').textContent") == "晚到的字幕仍可阅读"
            player.evaluate("document.querySelector('video').currentTime=8.1")
            player.wait_for_function("window.__shadow.querySelector('.translation').hidden")
            # Pause/resume no longer aborts an in-progress transcription.
            before=player.evaluate("window.__messages.filter(m=>m.type==='DISCONTINUITY').length")
            player.evaluate("['pause','play','ratechange'].forEach(e=>document.querySelector('video').dispatchEvent(new Event(e)))")
            assert player.evaluate("window.__messages.filter(m=>m.type==='DISCONTINUITY').length") == before
            player.evaluate("window.__deliver({type:'SESSION',active:false})")
            assert player.locator("#tingjian-subtitles").evaluate("el => getComputedStyle(el).display") == "none"
            assert not errors, errors
            browser.close()
            print("Browser checks passed: settings, credentials, popup start/stop, player display, seek invalidation, text escaping.")
            print("Screenshots:", OUTPUT)
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    run()
