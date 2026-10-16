import { api } from "./shared.js";
import { AudioTimeline } from "./audio-timeline.js";
let session=null, lastState={active:false,text:"尚未启动"};
const relay=m=>chrome.runtime.sendMessage(m).catch(()=>null);
function status(s,text,error=false) {
  if(session!==s)return;s.text=text;s.error=error;
  relay({type:"STATUS",tabId:s.tabId,text,error,active:true});
}
async function stop() {
  const s=session;session=null;
  if(s){s.request?.abort();clearInterval(s.timer);await relay({type:"SESSION_ENDED",tabId:s.tabId});}
  lastState={active:false,text:"已停止"};
}
async function tick(s) {
  if(session!==s || s.busy || Date.now()<(s.retryAt||0))return;s.busy=true;
  try {
    let clock=await relay({type:"CLOCK",tabId:s.tabId});
    if(!clock?.hasVideo || clock.ad || clock.seeking)return;
    if(s.videoId!==clock.videoId || s.cacheEpoch!==clock.cacheEpoch) {
      s.videoId=clock.videoId;s.cacheEpoch=clock.cacheEpoch;s.snapshot=null;s.version="";s.done=[];s.audio=[];s.timeline=new AudioTimeline();s.scanTime=null;
    }
    s.request=new AbortController();
    const options={signal:AbortSignal.any([s.request.signal,AbortSignal.timeout(90000)])};
    if(!s.ready) {status(s,"正在准备 Whisper 模型…");await api("/warmup",s.settings,{...options,method:"POST"});s.ready=true;}
    const snap=await relay({type:"MEDIA_SNAPSHOT",tabId:s.tabId,version:s.version,time:s.scanTime??clock.time});
    if(snap?.error) throw Error(snap.error);
    if(snap?.data) {
      const bytes=Uint8Array.from(atob(snap.data),c=>c.charCodeAt(0));
      s.snapshot=new Blob([bytes],{type:"application/octet-stream"});s.meta=snap;s.version=snap.version;s.decodeAt=null;s.lastBytesAt=Date.now();
    }
    if(!s.snapshot) {status(s,"等待播放器下载音频分片…");return;}
    // Re-decode on new bytes or after seeking beyond the previous extraction window.
    if(s.decodeAt===null || Math.abs(clock.time-s.decodeAt)>20) {
      const q=new URLSearchParams({format:s.meta.mime.includes("webm")?"webm":"mp4",offset:s.meta.offset,
        start:Math.max(0,clock.time-60),end:clock.time+60,chunk:s.settings.chunkSeconds,
        append_start:s.meta.appendStart||0,context:0});
      if(s.meta.appendEnd!=null)q.set("append_end",s.meta.appendEnd);
      const decoded=await api(`/decode?${q}`,s.settings,{...options,method:"POST",body:s.snapshot});
      s.timeline.add(decoded.chunks,clock.time);s.audio=s.timeline.jobs(s.settings.chunkSeconds);s.decodeAt=clock.time;
    }
    if(Number.isFinite(snap?.nextStart) && snap.nextStart<=clock.time+60)s.scanTime=snap.nextStart;
    const fresh=await relay({type:"CLOCK",tabId:s.tabId});
    if(session!==s || s.request.signal.aborted || fresh?.revision!==clock.revision || fresh.videoId!==clock.videoId || fresh.ad || fresh.seeking)return;
    clock=fresh;
    const now=Date.now();s.done=s.done.filter(d=>now-d.at<60000);
    const jobs=s.audio.filter(j=>j.coreEnd>clock.time-8 && j.coreStart<clock.time+60 &&
      (j.complete!==false || ((clock.ended || (j.coreEnd-j.coreStart>=1 && clock.time>=j.coreStart+1)) && now-s.lastBytesAt>=1800)) &&
      !s.done.some(d=>Math.abs(d.start-j.coreStart)<.04 && d.end>=j.coreEnd-.04 && (d.complete || j.complete===false)));
    const priority=j=>j.coreStart<=clock.time && j.coreEnd>clock.time ? 0 : j.coreEnd<=clock.time ? 1 : 2;
    jobs.sort((a,b)=>priority(a)-priority(b) || (priority(a)===1 ? b.coreStart-a.coreStart : a.coreStart-b.coreStart));
    const job=jobs[0];
    if(!job) {status(s,"字幕预读已跟上 · 等待新的音频分片");return;}
    status(s,`正在识别 ${job.start.toFixed(1)}–${job.end.toFixed(1)} 秒的音频…`);
    const pcm=Uint8Array.from(atob(job.pcm),c=>c.charCodeAt(0));
    const q=new URLSearchParams({language:s.settings.language,target:s.settings.target,
      clip_start:Math.max(0,job.coreStart-job.start),clip_end:Math.min(12,job.coreEnd-job.start)});
    const result=await api(`/transcribe?${q}`,s.settings,{...options,method:"POST",body:pcm,headers:{"Content-Type":"application/octet-stream"}});
    if(session!==s || s.request.signal.aborted)return;
    const latest=await relay({type:"CLOCK",tabId:s.tabId});
    if(session!==s || s.request.signal.aborted || latest?.revision!==clock.revision || latest.videoId!==clock.videoId)return;
    const delivered=await relay({type:"SUBTITLE",tabId:s.tabId,data:{videoId:clock.videoId,revision:clock.revision,
      range:{start:job.coreStart,end:job.coreEnd,silence:result.silence===true},
      cues:result.cues.map(c=>({...c,start:job.start+c.start,end:job.start+c.end}))}});
    if(delivered?.ok)s.done.push({start:job.coreStart,end:job.coreEnd,complete:job.complete!==false,at:Date.now()});
    status(s,result.warning || `预读字幕 · 上段处理 ${(result.processing_ms/1000).toFixed(1)} 秒`,Boolean(result.warning));
  } catch(e) {
    if(e.status===429)s.retryAt=Date.now()+1500;
    if(session===s && e.name!=="AbortError")status(s,e.message==="Failed to fetch"?"本机服务连接中断；YouTube 原声继续播放。":e.message,true);
  } finally {s.busy=false;s.request=null;}
}
chrome.runtime.onMessage.addListener((m,sender,respond)=>{
  if(m.target!=="offscreen" || sender.id!==chrome.runtime.id || sender.tab)return;
  (async()=>{
    if(m.type==="STOP"){await stop();return{ok:true};}
    if(m.type==="START"){
      await stop();const s={tabId:m.tabId,settings:m.settings,ready:false,busy:false,done:[],audio:[],version:"",text:"正在准备字幕…"};
      session=s;s.timer=setInterval(()=>tick(s),600);return{ok:true};
    }
    if(m.type==="RESET" && session?.tabId===m.tabId){session.request?.abort();session.scanTime=null;return{ok:true};}
    if(m.type==="STATE")return session?{active:true,tabId:session.tabId,text:session.text,error:session.error}:lastState;
    return{ok:false};
  })().then(respond).catch(e=>respond({ok:false,error:e.message}));return true;
});
