(() => {
  if (globalThis.__tingjianInstalled) return;
  globalThis.__tingjianInstalled = true;
  const cache = new TingjianSync.SubtitleCache();
  const presenter = new TingjianSync.SubtitlePresenter();
  let active = false, revision = 0, cacheEpoch = 0, lastAd = false, boundVideo = null, identity = "", statusText = "正在准备字幕…";
  let settings = { fontSize: 26, showOriginal: true, bottom: 12 };
  const send = m => chrome.runtime.sendMessage(m).catch(() => null);
  const host = document.createElement("div"); host.id = "tingjian-subtitles";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `<style>
    :host{position:absolute;left:5%;right:5%;bottom:12%;z-index:2147483646;pointer-events:none;text-align:center;display:none;font-family:system-ui,"Microsoft YaHei",sans-serif}
    .line{width:fit-content;max-width:100%;margin:4px auto;padding:5px 13px;border-radius:7px;color:white;background:rgba(10,15,21,.84);line-height:1.5;overflow-wrap:anywhere;text-shadow:0 1px 3px #000;box-sizing:border-box}
    .translation{font-weight:650}.original{color:#e5e9ee;font-size:.72em}.status{display:inline-block;font-size:12px;color:#d7efe7;padding:5px 10px;border-radius:6px;background:rgba(10,15,21,.8)}[hidden]{display:none!important}
    </style><div class="line translation" hidden></div><div class="line original" hidden></div><div class="status" hidden></div>`;
  const translation=shadow.querySelector(".translation"), original=shadow.querySelector(".original"), badge=shadow.querySelector(".status");
  function videoId() { const u=new URL(location.href); return u.searchParams.get("v") || u.pathname.split("/").filter(Boolean).at(-1) || ""; }
  function clock() {
    const v=boundVideo;
    return { hasVideo:Boolean(v), time:v?.currentTime || 0, rate:v?.playbackRate || 1, paused:!v || v.paused,
      seeking:Boolean(v?.seeking), ended:Boolean(v?.ended), ad:Boolean(v?.closest(".ad-showing")),
      readyState:v?.readyState || 0, revision, cacheEpoch, videoId:identity,
      seekable: v ? [...Array(v.seekable.length)].map((_,i)=>[v.seekable.start(i),v.seekable.end(i)]) : [] };
  }
  function render() {
    const ad=Boolean(boundVideo?.closest(".ad-showing"));
    if(ad!==lastAd){lastAd=ad;cache.clear();presenter.reset();cacheEpoch++;revision++;}
    const c=clock(), match=active && !c.ad && !c.seeking ? presenter.at(cache.at(c.time),c.time,performance.now(),cache.isSilent(c.time)) : null;
    translation.textContent=match ? (match.cue.translation || match.cue.text) : "";
    original.textContent=match && settings.showOriginal && match.cue.translation ? match.cue.text : "";
    translation.hidden=!translation.textContent; original.hidden=!original.textContent;
    // Processing/error status remains in the extension popup. The player shows
    // subtitles only, including when the current timestamp has no cached cue.
    badge.textContent="";
    badge.hidden=true;
    host.dataset.mode=match ? (match.aligned ? "aligned" : "latest") : "waiting";
  }
  function changed(event) {
    const discontinuity=["seeking","emptied"].includes(event?.type);
    if (discontinuity) {revision++;presenter.reset();}
    render();
    // Pause/resume/rate changes do not invalidate timestamps or ongoing work.
    if (active && discontinuity) send({type:"DISCONTINUITY"});
  }
  const events=["seeking","seeked","pause","play","ratechange","emptied","ended"];
  function place() {
    const id=videoId();
    if (identity !== id) { identity=id; revision++; cacheEpoch++; cache.clear(); presenter.reset(); if(active) send({type:"DISCONTINUITY"}); }
    const v=document.querySelector("video.html5-main-video") || document.querySelector("video");
    if (v!==boundVideo) {
      if(boundVideo) for(const e of events) boundVideo.removeEventListener(e,changed);
      boundVideo=v; revision++;presenter.reset();
      if(v) for(const e of events) v.addEventListener(e,changed);
    }
    const parent=v?.closest(".html5-video-player") || document.querySelector("#movie_player");
    if(parent && host.parentElement!==parent) parent.appendChild(host);
  }
  function snapshot(version,time) {
    return new Promise(resolve => {
      const id=crypto.randomUUID();
      const done=data=>{clearTimeout(timer);window.removeEventListener("message",listener);resolve(data);};
      const listener=e=>{
        if(e.source!==window || e.origin!==location.origin || e.data?.channel!=="tingjian-media-response" || e.data.id!==id) return;
        const d=e.data;
        if(d.data && (typeof d.data!=="string" || d.data.length>12*1024*1024)) return done({error:"音频快照过大"});
        done({data:d.data,version:d.version,mime:d.mime,offset:d.offset,appendStart:d.appendStart,appendEnd:d.appendEnd,unchanged:d.unchanged,nextStart:d.nextStart,error:d.error});
      };
      const timer=setTimeout(()=>done({error:"请刷新 YouTube 页面以启用音频预读。"}),2500);
      window.addEventListener("message",listener);
      window.postMessage({channel:"tingjian-media-request",id,version,time},location.origin);
    });
  }
  chrome.runtime.onMessage.addListener((m,sender,respond)=>{
    if(sender.id!==chrome.runtime.id) return;
    place();
    if(m.type==="CLOCK") respond(clock());
    else if(m.type==="MEDIA_SNAPSHOT") {
      if(!active || clock().ad) {respond({error:"播放器尚未就绪"});return;}
      snapshot(m.version,m.time).then(respond);return true;
    } else if(m.type==="SESSION") {
      active=Boolean(m.active);cache.clear();presenter.reset();
      if(m.settings) settings={...settings,...m.settings};
      host.style.fontSize=`${Number(settings.fontSize)||26}px`;host.style.bottom=`${Number(settings.bottom)||12}%`;
      host.style.display=active?"block":"none";render();respond({ok:true});
    } else if(m.type==="STATUS") {statusText=m.text;render();respond({ok:true});}
    else if(m.type==="SUBTITLE") {
      if(!active || m.videoId!==identity || m.revision!==revision || clock().ad) {respond({ok:false});return;}
      cache.add(m.cues || [],Date.now(),m.range);render();respond({ok:true});
    }
  });
  document.addEventListener("yt-navigate-finish",place);
  document.addEventListener("yt-navigate-start",()=>{cache.clear();presenter.reset();revision++;render();});
  setInterval(()=>{place();if(active)render();},100);
  place();
})();
