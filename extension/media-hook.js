(() => {
  if (globalThis.__tingjianMediaHook || !globalThis.MediaSource) return;
  globalThis.__tingjianMediaHook = true;
  const sources = new WeakMap(), urls = new Map();
  let nextId = 0;
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
  URL.createObjectURL = function(object) {
    const url = Reflect.apply(create, this, arguments);
    if (object instanceof MediaSource) urls.set(url, object);
    return url;
  };
  // YouTube may revoke its blob URL after attaching it; retain the association
  // until its MediaSource closes, so the playing element can still be identified.
  URL.revokeObjectURL = function(url) { return Reflect.apply(revoke, this, arguments); };
  const add = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function(mime) {
    const buffer = Reflect.apply(add, this, arguments);
    if (!/^audio\/(mp4|webm)/i.test(mime)) return buffer;
    const record = { id: ++nextId, buffer, mime, parser: new TingjianMedia.MediaAssembler(mime), snapshots:new Map(), offset: null, error: "" };
    if (!sources.has(this)) {
      sources.set(this, []);
      this.addEventListener("sourceclose", () => { for (const [url, source] of urls) if (source === this) urls.delete(url); });
    }
    sources.get(this).push(record);
    if (buffer.changeType) {
      const change = buffer.changeType;
      buffer.changeType = function(type) {
        const result = Reflect.apply(change, this, arguments);
        record.mime=type;record.id=++nextId;record.parser=new TingjianMedia.MediaAssembler(type);record.snapshots.clear();record.offset=null;
        record.error=/^audio\/(mp4|webm)/i.test(type)?"":"切换后的音轨格式暂不支持";
        return result;
      };
    }
    const append = buffer.appendBuffer;
    buffer.appendBuffer = function(data) {
      // Copy first (append can detach the buffer); always invoke native append
      // exactly once. Any subtitle error is isolated from native playback.
      let copy;
      try {
        if (data.byteLength <= 8*1024*1024) copy = new Uint8Array(ArrayBuffer.isView(data) ? data.buffer : data,
          ArrayBuffer.isView(data) ? data.byteOffset : 0, data.byteLength).slice();
      } catch {}
      const offset = buffer.timestampOffset, mode = buffer.mode;
      const result = Reflect.apply(append, this, arguments);
      try {
        if (mode !== "segments") throw Error("此音轨使用 sequence 模式，暂不能可靠对齐时间戳");
        if (!/^audio\/(mp4|webm)/i.test(record.mime)) throw Error("音轨格式暂不支持");
        if (record.offset !== null && record.offset !== offset) {
          record.parser.parts=[];record.parser.size=0;record.parser.pending=new Uint8Array();
          record.parser.fragment=[];record.parser.cluster=null;record.parser.generation++;
          record.parser.timeStart=null;
        }
        record.offset = offset;
        if (!copy) throw Error("音频分片超过读取上限");
        record.parser.push(copy); record.error = "";
        const bytes=record.parser.snapshot();
        if(bytes) {
          const key=`${offset}:${record.parser.generation}`;
          record.snapshots.set(key,{bytes,offset,mime:record.mime,start:record.parser.timeStart===null?null:record.parser.timeStart+offset,
            version:`${record.id}:${key}:${record.parser.version}`});
          let size=[...record.snapshots.values()].reduce((n,x)=>n+x.bytes.length,0);
          while(record.snapshots.size>120 || size>12*1024*1024) {
            const oldest=record.snapshots.keys().next().value;size-=record.snapshots.get(oldest).bytes.length;record.snapshots.delete(oldest);
          }
        }
      } catch (error) { record.error = String(error.message); }
      return result;
    };
    return buffer;
  };
  window.addEventListener("message", event => {
    const m = event.data;
    if (event.source !== window || event.origin !== location.origin || m?.channel !== "tingjian-media-request" || typeof m.id !== "string") return;
    const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
    let response = { error: "未收到可读取的音频分片。更新扩展后请刷新 YouTube 页面。" };
    if (video?.mediaKeys) response = { error: "此媒体受保护，无法读取音频分片。" };
    else {
      const records = sources.get(urls.get(video?.currentSrc || video?.src)) || [];
      const candidates = records.filter(r => { try { return [...Array(r.buffer.buffered.length)].some((_,i) => r.buffer.buffered.start(i) <= video.currentTime && r.buffer.buffered.end(i) > video.currentTime); } catch { return false; } });
      const record = candidates.at(-1) || records.at(-1);
      if (record) {
        const target=Number.isFinite(m.time)?Math.max(video.currentTime,Math.min(video.currentTime+60,m.time)):video.currentTime;
        const {selected,nextStart}=TingjianMedia.selectSnapshot([...record.snapshots.values()],target);
        const version=selected?.version;
        if (record.error) response = { error: record.error };
        else if (version && version === m.version) response = { unchanged: true, version, nextStart };
        else {
          const bytes = selected?.bytes;
          if (bytes) {
            let binary = "";
            for (let i=0;i<bytes.length;i+=16384) binary += String.fromCharCode(...bytes.subarray(i,i+16384));
            response = { version, mime: selected.mime, offset: selected.offset, data: btoa(binary), nextStart,
              appendStart: record.buffer.appendWindowStart,
              appendEnd: Number.isFinite(record.buffer.appendWindowEnd) ? record.buffer.appendWindowEnd : null };
          }
        }
      }
    }
    window.postMessage({ channel: "tingjian-media-response", id: m.id, ...response }, location.origin);
  });
})();
