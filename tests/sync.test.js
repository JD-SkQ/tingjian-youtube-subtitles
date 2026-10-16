import test from "node:test";
import assert from "node:assert/strict";
import "../extension/sync-core.js";
import "../extension/media-parser.js";
const {SubtitleCache,SubtitlePresenter}=globalThis.TingjianSync;
const {MediaAssembler}=globalThis.TingjianMedia;
test("timestamp match outranks latest, pause and rewind reuse cache",()=>{
  const c=new SubtitleCache();c.add([{start:10,end:12,text:"first"},{start:20,end:22,text:"newest"}],1000);
  assert.equal(c.at(11,2000).cue.text,"first");assert.equal(c.at(11,2000).aligned,true);
  assert.equal(c.at(15,2000).cue.text,"first");assert.equal(c.at(15,2000).aligned,false);
  assert.equal(c.at(19,2000),null);assert.equal(c.at(9,2000),null);
  assert.equal(c.at(21,2000).cue.text,"newest");assert.equal(c.at(11,3000).cue.text,"first");
  assert.equal(c.at(11,61000),null);
});
test("future prefetch never leaks into a gap; expired late text cannot linger",()=>{
  const c=new SubtitleCache();
  c.add([{start:4,end:6,text:"just played"}],1000);
  c.add([{start:40,end:44,text:"future"}],2000);
  assert.equal(c.at(7,3000).cue.text,"just played");
  assert.equal(c.at(13,3000),null);
  assert.equal(c.at(7,8000).cue.text,"just played");
  assert.equal(c.at(41,30000).cue.text,"future");
  assert.equal(c.at(2,3000),null);
});
test("end is exclusive, malformed cues ignored and session clear isolates videos",()=>{
  const c=new SubtitleCache();c.add([{start:1,end:2,text:"one"},{start:NaN,end:4,text:"bad"}],0);
  assert.equal(c.at(2,1).aligned,false);assert.equal(c.cues.length,1);c.clear();assert.equal(c.at(1,1),null);
});
test("newer recognition replaces identical timestamps",()=>{
  const c=new SubtitleCache();c.add([{start:1,end:2,text:"old"}],1);c.add([{start:1,end:2,text:"new"}],2);
  assert.equal(c.cues.length,1);assert.equal(c.at(1.5,3).cue.text,"new");
});
test("known silence stays blank and full chunks replace partial hypotheses",()=>{
  const c=new SubtitleCache();
  c.add([{start:1,end:2,text:"partial"}],1000,{start:0,end:2});
  c.add([{start:1.5,end:3,text:"complete"}],2000,{start:0,end:4});
  assert.equal(c.at(1.2,2500),null);
  assert.equal(c.at(2.5,2500).cue.text,"complete");
  assert.equal(c.at(3.5,2500).cue.text,"complete");
  c.add([],3000,{start:4,end:8,silence:true});
  assert.equal(c.at(4.2,3100),null);
  assert.equal(c.cues.length,1);
});
test("empty recognition is not silence and cannot erase an existing sentence",()=>{
  const c=new SubtitleCache();c.add([{start:1,end:3,text:"heard speech"}],1000,{start:0,end:4});
  c.add([],1100,{start:0,end:4,silence:false});
  assert.equal(c.at(2,1200).cue.text,"heard speech");
  c.add([],1300,{start:0,end:4,silence:true});assert.equal(c.at(2,1400),null);
});
test("late subtitles remain readable but next cue and seek always take priority",()=>{
  const p=new SubtitlePresenter(),first={cue:{start:1,end:2,text:"late"},aligned:true};
  assert.equal(p.at(first,1.95,0),first);
  assert.equal(p.at(null,2.05,100),first);
  assert.equal(p.at(null,2.7,750),first);
  assert.equal(p.at(null,2.9,950),first);
  assert.equal(p.at(null,8.1,6150),null);
  p.at(first,1.95,1000);
  const next={cue:{start:2,end:4,text:"next"},aligned:true};
  assert.equal(p.at(next,2.1,1100),next);
  p.reset();assert.equal(p.at(null,1.9,1200),null);
  p.at(first,1.95,2000);assert.equal(p.at(null,2.1,2100,true),null);
});
const box=(name,payload=[])=>{const out=new Uint8Array(payload.length+8);new DataView(out.buffer).setUint32(0,out.length);out.set([...name].map(c=>c.charCodeAt(0)),4);out.set(payload,8);return out;};
test("fragmented MP4 survives arbitrary transport splitting",()=>{
  const parts=[box("ftyp"),box("moov"),box("moof",[1,2]),box("mdat",[3,4,5])];
  const all=Uint8Array.from(parts.flatMap(p=>[...p])),p=new MediaAssembler("audio/mp4");
  for(let i=0;i<all.length;i+=3)p.push(all.slice(i,i+3));
  assert.deepEqual(p.snapshot(),all);assert.equal(p.parts.length,1);
  p.push(box("ftyp"));assert.equal(p.snapshot(),null);assert.equal(p.generation,2);
});
test("oversized or invalid MP4 cannot accumulate unbounded bytes",()=>{
  const p=new MediaAssembler("audio/mp4");assert.throws(()=>p.push(new Uint8Array(8)));assert.throws(()=>p.push(new Uint8Array(9*1024*1024)));
});
