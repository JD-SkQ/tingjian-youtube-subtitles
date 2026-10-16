"""Actual MSE playback + media hook + backend decoder; no user browser profile."""
import functools
import json
import subprocess
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/"test-results"
MOCK=r"""
window.__listeners=[];
window.chrome={runtime:{id:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',onMessage:{addListener:f=>window.__listeners.push(f)},sendMessage:async()=>({ok:true})}};
window.__deliver=m=>new Promise(resolve=>{for(const f of window.__listeners)f(m,{id:chrome.runtime.id},resolve);});
const attach=Element.prototype.attachShadow;
Element.prototype.attachShadow=function(o){const s=attach.call(this,o);window.__shadow=s;return s;};
void 0;
"""

class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self,*args): pass

def run():
    OUT.mkdir(exist_ok=True)
    subprocess.run([str(ROOT/".venv/Scripts/python.exe"),"-c",
        "import runpy; from pathlib import Path; f=runpy.run_path('tests/test_media.py')['fixture_bytes']; "
        "[Path('test-results/mse.'+x).write_bytes(f(x)) for x in ['mp4','webm']]"],cwd=ROOT,check=True)
    server=ThreadingHTTPServer(("127.0.0.1",0),functools.partial(QuietHandler,directory=str(ROOT)))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    base=f"http://127.0.0.1:{server.server_port}"
    results=[]
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True,args=["--autoplay-policy=no-user-gesture-required"])
            for format,mime in [("mp4",'audio/mp4; codecs="mp4a.40.2"'),("webm",'audio/webm; codecs="opus"')]:
                page=browser.new_page(viewport={"width":1000,"height":700})
                errors=[];page.on("pageerror",lambda e:errors.append(str(e)))
                page.goto(base+"/");page.evaluate(MOCK)
                page.set_content("""<html><body style='background:#101824;color:white;font-family:Arial'>
                <h2>原生播放 · 时间戳字幕测试</h2><div id='movie_player' class='html5-video-player' style='position:relative;width:960px;height:540px;background:#182f49'>
                <video class='html5-main-video' controls style='width:100%;height:100%'></video></div></body></html>""")
                for script in ["media-parser.js","media-hook.js","sync-core.js","content.js"]:
                    page.add_script_tag(path=str(ROOT/"extension"/script))
                page.evaluate("""async ({mime,format})=>{
                  window.v=document.querySelector('video');v.volume=.65;
                  window.ms=new MediaSource();v.src=URL.createObjectURL(ms);
                  await new Promise(r=>ms.addEventListener('sourceopen',r,{once:true}));
                  window.sb=ms.addSourceBuffer(mime);sb.timestampOffset=100;
                  const bytes=new Uint8Array(await (await fetch('/test-results/mse.'+format)).arrayBuffer());
                  // Network chunks deliberately cut through MP4/EBML headers.
                  for(let at=0;at<bytes.length;at+=7777){const done=new Promise((r,j)=>{sb.addEventListener('updateend',r,{once:true});sb.addEventListener('error',j,{once:true});});sb.appendBuffer(bytes.slice(at,at+7777));await done;}
                  // Revoking an attached blob must not break source identification.
                  URL.revokeObjectURL(v.src);v.currentTime=101;await v.play();
                  await window.__deliver({type:'SESSION',active:true,settings:{fontSize:26,showOriginal:true,bottom:12}});
                }""",{"mime":mime,"format":format})
                snapshot=page.evaluate("window.__deliver({type:'MEDIA_SNAPSHOT'})")
                assert snapshot.get("data"),snapshot
                assert snapshot["offset"]==100
                if format=="mp4":
                    # YouTube may append a new initialization and download audio
                    # two minutes ahead. Keep the old bundle for current playback.
                    page.evaluate("""async()=>{
                      const bytes=new Uint8Array(await (await fetch('/test-results/mse.mp4')).arrayBuffer());
                      const view=new DataView(bytes.buffer);
                      for(let i=4;i<bytes.length-16;i++){
                        if(bytes[i]===116&&bytes[i+1]===102&&bytes[i+2]===100&&bytes[i+3]===116){
                          if(bytes[i+4]===1)view.setBigUint64(i+8,view.getBigUint64(i+8)+BigInt(120*48000));
                          else view.setUint32(i+8,view.getUint32(i+8)+120*48000);
                        }
                      }
                      const done=new Promise((r,j)=>{sb.addEventListener('updateend',r,{once:true});sb.addEventListener('error',j,{once:true});});
                      sb.appendBuffer(bytes);await done;
                    }""")
                    retained=page.evaluate("window.__deliver({type:'MEDIA_SNAPSHOT'})")
                    assert retained["data"]==snapshot["data"],"Future initialization discarded the currently watched audio"
                # Decode the actual copied snapshot, with the same offset used by MSE.
                snapfile=OUT/f"snapshot-{format}.json";snapfile.write_text(json.dumps(snapshot),encoding="utf-8")
                check=subprocess.run([str(ROOT/".venv/Scripts/python.exe"),"-c",
                    "import json,base64; from backend.media import decode_segments; "
                    f"s=json.load(open('test-results/snapshot-{format}.json')); "
                    f"c=decode_segments(base64.b64decode(s['data']),'{format}',s['offset'],100,112,4); "
                    "assert c and c[0]['start']>=100 and c[-1]['end']>111; "
                    "print(json.dumps({'first':c[0]['start'],'last':c[-1]['end'],'chunks':len(c)}))"],cwd=ROOT,check=True,capture_output=True,text=True)
                decoded=json.loads(check.stdout)
                page.evaluate("""async()=>{
                  const c=await window.__deliver({type:'CLOCK'});
                  await window.__deliver({...c,type:'SUBTITLE',cues:[{start:100,end:104,text:'first',translation:'第一句：按时间对齐'},{start:105,end:108,text:'second',translation:'第二句：回退仍能匹配'}]});
                }""")
                page.wait_for_function("document.querySelector('#tingjian-subtitles').dataset.mode==='aligned'")
                page.evaluate("v.pause()")
                assert page.evaluate("!v.muted && v.volume===.65")
                before=page.evaluate("v.currentTime");page.wait_for_timeout(200)
                assert page.evaluate("v.currentTime")==before
                page.evaluate("v.currentTime=106")
                page.wait_for_function("window.__shadow.querySelector('.translation').textContent.includes('第二句')")
                page.evaluate("v.currentTime=102")
                page.wait_for_function("window.__shadow.querySelector('.translation').textContent.includes('第一句')")
                page.evaluate("v.currentTime=104.5")
                page.wait_for_function("document.querySelector('#tingjian-subtitles').dataset.mode==='latest'")
                assert page.evaluate("window.__shadow.querySelector('.status').hidden")
                assert page.evaluate("window.__shadow.querySelector('.status').textContent") == ""
                assert "第一句" in page.evaluate("window.__shadow.querySelector('.translation').textContent")
                page.evaluate("v.currentTime=102;v.play()")
                page.wait_for_function("v.currentTime>102.5")
                # Probe the native captured audio track. This test-only graph does
                # not alter the extension, and has zero gain to avoid duplicate sound.
                energy=page.evaluate("""async()=>{
                  const stream=v.captureStream(),ctx=new AudioContext();await ctx.resume();
                  const src=ctx.createMediaStreamSource(stream),an=ctx.createAnalyser(),gain=ctx.createGain();
                  gain.gain.value=0;src.connect(an);an.connect(gain);gain.connect(ctx.destination);
                  await new Promise(r=>setTimeout(r,200));const a=new Float32Array(an.fftSize);an.getFloatTimeDomainData(a);
                  const rms=Math.sqrt(a.reduce((n,x)=>n+x*x,0)/a.length);await ctx.close();stream.getTracks().forEach(t=>t.stop());return rms;
                }""")
                assert energy>.02,energy
                page.screenshot(path=str(OUT/f"native-{format}.png"))
                page.evaluate("window.__deliver({type:'SESSION',active:false})")
                stopped=page.evaluate("v.currentTime");page.wait_for_function("t=>v.currentTime>t+.2",arg=stopped)
                assert page.locator("video").count()==1 and page.locator("canvas").count()==0
                assert page.evaluate("!v.muted && v.volume===.65")
                assert not errors,errors
                results.append({"format":format,"decoded":decoded,"native_audio_rms":energy,"pause_seek_resume":True})
                page.close()
            browser.close()
        (OUT/"native-playback-results.json").write_text(json.dumps(results,indent=2),encoding="utf-8")
        print(json.dumps(results,indent=2))
    finally:
        server.shutdown();server.server_close()

if __name__=="__main__":run()
