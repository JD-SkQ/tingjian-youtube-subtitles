import test from 'node:test';
import assert from 'node:assert/strict';
import {AudioTimeline} from '../extension/audio-timeline.js';
import '../extension/media-parser.js';
const audio=(start,end)=>({start,end,pcm:btoa('\0'.repeat(Math.round((end-start)*32000)))});
test('independent live snapshots retain current audio and join contexts across initialization boundaries',()=>{
  const t=new AudioTimeline();t.add([audio(100,105)],102);
  t.add([audio(105,110)],102);
  const j=t.jobs(4).find(j=>j.coreStart===104);
  assert.equal(j.coreEnd,108);assert.equal(j.start,103);assert.equal(j.end,109);assert.equal(j.complete,true);
  t.add([audio(220,225)],102); // Most recently downloaded content can be two minutes ahead.
  assert.equal(t.jobs(4).find(j=>j.coreStart===104).complete,true);
});
test('PCM cache preserves real time gaps and evicts old ranges',()=>{
  const t=new AudioTimeline();t.add([audio(100,104),audio(108,112)],105);
  assert.equal(t.spans.length,2);assert.equal(t.jobs(4).some(j=>j.coreStart===104),false);
  t.add([],200);assert.equal(t.spans.length,0);
});
test('media snapshot selection follows playback and rewind rather than download order',()=>{
  const {selectSnapshot}=globalThis.TingjianMedia;
  const past={start:100},current={start:105},future={start:220};
  assert.equal(selectSnapshot([past,current,future],106).selected,current);
  assert.equal(selectSnapshot([past,current,future],102).selected,past);
  assert.equal(selectSnapshot([past,current,future],106).nextStart,220);
});
