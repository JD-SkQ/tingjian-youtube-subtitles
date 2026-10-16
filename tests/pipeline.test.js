import test from "node:test";
import assert from "node:assert/strict";

test("prefetch runs while paused, seeks follow media time, fallback uses recent audio; no audio capture",async()=>{
  const nativeFetch=globalThis.fetch,nativeInterval=globalThis.setInterval,nativeClear=globalThis.clearInterval,nativeNow=Date.now;
  let now=10000,version="1";Date.now=()=>now;
  let listener,tick,clock={hasVideo:true,time:5,paused:true,seeking:false,ended:false,ad:false,revision:1,cacheEpoch:0,videoId:"video"};
  const delivered=[],posts=[];
  const audio=(start,end)=>({start,end,pcm:btoa("\0".repeat(Math.round((end-start)*32000)))});
  let jobs=[audio(0,4),audio(4,8),audio(8,12),audio(12,16)];
  globalThis.setInterval=f=>{tick=f;return 1;};globalThis.clearInterval=()=>{};
  globalThis.chrome={runtime:{id:"test",onMessage:{addListener:f=>listener=f},sendMessage:async m=>{
    if(m.type==="CLOCK")return {...clock};
    if(m.type==="MEDIA_SNAPSHOT")return m.version===version?{unchanged:true}:{version,mime:"audio/mp4",offset:0,data:btoa("media")};
    if(m.type==="SUBTITLE"){delivered.push(m);return{ok:true};}return{ok:true};
  }}};
  Object.defineProperty(chrome,"tabCapture",{get(){throw Error("must never capture playback audio");}});
  globalThis.fetch=async(url,options)=>{
    const parsed=new URL(url),path=parsed.pathname;posts.push(path);
    const clip=Number(parsed.searchParams.get('clip_start')||0);
    return new Response(JSON.stringify(path==="/decode"?{chunks:jobs}:path==="/transcribe"?{
      cues:[{start:clip+.2,end:clip+1,text:"speech",translation:"语音"}],processing_ms:10
    }:{ok:true}),{status:200,headers:{"Content-Type":"application/json"}});
  };
  try {
    await import("../extension/offscreen.js");
    const send=m=>new Promise(resolve=>listener({target:"offscreen",...m},{id:"test"},resolve));
    await send({type:"START",tabId:7,settings:{token:"test",chunkSeconds:4,language:"auto",target:"zh"}});
    await tick();assert.equal(delivered[0].data.cues[0].start,4.2);assert.equal(clock.paused,true);
    await tick();assert.equal(delivered[1].data.cues[0].start,.2); // Recover missed recent speech before distant future.
    await tick();assert.equal(delivered[2].data.cues[0].start,8.2);
    clock={...clock,time:1,revision:2};await send({type:"RESET",tabId:7});await tick();
    assert.equal(delivered.length,3); // Rewind reuses cache instead of recognizing the same range again.
    // Different video has no done ranges from the old one. At live edge, most
    // recently downloaded audio is behind currentTime and must still be processed.
    clock={...clock,time:13,videoId:"other",revision:3};await tick();
    assert.equal(delivered[3].data.cues[0].start,8.2);
    // Growing tiny tails must not trigger repeated transcription. Once stalled
    // with usable context they can flush once, and a completed chunk can replace them.
    clock={...clock,time:1,videoId:"tail",revision:4};version="2";
    jobs=[audio(0,.5)];
    await tick();now+=2500;await tick();assert.equal(delivered.length,4);
    version="3";jobs[0]=audio(0,2);await tick();assert.equal(delivered.length,4);
    now+=1900;await tick();assert.equal(delivered.length,5);
    await tick();assert.equal(delivered.length,5);
    version="4";jobs[0]=audio(0,5);await tick();assert.equal(delivered.length,6);
    await tick();assert.equal(delivered.length,6);
    assert.equal(posts.filter(p=>p==="/warmup").length,1);
    await send({type:"STOP"});assert.equal((await send({type:"STATE"})).active,false);
  } finally {globalThis.fetch=nativeFetch;globalThis.setInterval=nativeInterval;globalThis.clearInterval=nativeClear;Date.now=nativeNow;delete globalThis.chrome;}
});
