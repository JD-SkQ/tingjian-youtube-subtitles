// A rolling PCM timeline outlives individual YouTube initialization segments.
// All indices are absolute 16 kHz media samples; no playback audio is produced.
const RATE=16000;
function fromBase64(value) {
  const bytes=Uint8Array.from(atob(value),c=>c.charCodeAt(0)),view=new DataView(bytes.buffer);
  const pcm=new Int16Array(bytes.length/2);for(let i=0;i<pcm.length;i++)pcm[i]=view.getInt16(i*2,true);return pcm;
}
function toBase64(pcm) {
  const bytes=new Uint8Array(pcm.length*2),view=new DataView(bytes.buffer);
  for(let i=0;i<pcm.length;i++)view.setInt16(i*2,pcm[i],true);
  let s="";for(let i=0;i<bytes.length;i+=16384)s+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(s);
}
export class AudioTimeline {
  constructor(){this.spans=[];}
  add(chunks,time) {
    const low=Math.round(Math.max(0,time-60)*RATE),high=Math.round((time+60)*RATE);
    this.spans=this.spans.filter(s=>s.end>low && s.start<high).map(s=>{
      const start=Math.max(low,s.start),end=Math.min(high,s.end);
      return{start,end,pcm:s.pcm.slice(start-s.start,end-s.start)};
    });
    for(const chunk of chunks) {
      const pcm=fromBase64(chunk.pcm),origin=Math.round(chunk.start*RATE);
      const start=Math.max(low,origin),end=Math.min(high,origin+pcm.length);
      if(end<=start)continue;
      const overlaps=this.spans.filter(s=>s.end>=start-2 && s.start<=end+2);
      const first=Math.min(start,...overlaps.map(s=>s.start)),last=Math.max(end,...overlaps.map(s=>s.end));
      const merged=new Int16Array(last-first);
      for(const s of overlaps)merged.set(s.pcm,s.start-first);
      merged.set(pcm.subarray(start-origin,end-origin),start-first);
      this.spans=this.spans.filter(s=>!overlaps.includes(s));this.spans.push({start:first,end:last,pcm:merged});
    }
    this.spans.sort((a,b)=>a.start-b.start);
  }
  jobs(seconds) {
    const jobs=[],step=Math.round(seconds*RATE);
    for(const [index,s] of this.spans.entries()) {
      let at=s.start;
      while(at<s.end) {
        const boundary=(Math.floor(at/step)+1)*step,coreEnd=Math.min(s.end,boundary);
        if(coreEnd-at>=1600) {
          const start=Math.max(s.start,at-RATE),end=Math.min(s.end,coreEnd+RATE);
          jobs.push({start:start/RATE,end:end/RATE,coreStart:at/RATE,coreEnd:coreEnd/RATE,
            complete:(coreEnd===boundary && s.end>=boundary+RATE) || index<this.spans.length-1,
            pcm:toBase64(s.pcm.subarray(start-s.start,end-s.start))});
        }
        at=coreEnd;
      }
    }
    return jobs;
  }
}
