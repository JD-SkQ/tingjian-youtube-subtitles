/* Bounded, incremental MSE initialization/media segment assembler. */
(() => {
  const join = parts => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out;
  };
  function mp4Field(bytes, wanted, at=0, end=bytes.length) {
    while(at+8<=end) {
      const view=new DataView(bytes.buffer,bytes.byteOffset+at,end-at);
      let size=view.getUint32(0),header=8;
      if(size===1){if(end-at<16)return null;size=Number(view.getBigUint64(8));header=16;}
      if(size<header || at+size>end)return null;
      const type=String.fromCharCode(...bytes.subarray(at+4,at+8));
      if(type===wanted)return bytes.subarray(at+header,at+size);
      if(["moov","trak","mdia","moof","traf"].includes(type)) {
        const found=mp4Field(bytes,wanted,at+header,at+size);if(found)return found;
      }
      at+=size;
    }
    return null;
  }
  function vint(bytes, at, keepMarker = false) {
    if (at >= bytes.length || !bytes[at]) return null;
    let n = 1, mask = 128;
    while (!(bytes[at] & mask)) { n++; mask >>= 1; }
    if (n > 8 || at + n > bytes.length) return null;
    let value = keepMarker ? bytes[at] : bytes[at] & (mask - 1);
    let unknown = !keepMarker && value === mask - 1;
    for (let i = 1; i < n; i++) { value = value * 256 + bytes[at + i]; unknown = unknown && bytes[at + i] === 255; }
    return { length: n, value, unknown };
  }
  class MediaAssembler {
    constructor(mime) { this.webm = mime.includes("webm"); this.reset(); }
    reset() { this.generation = (this.generation || 0) + 1; this.pending = new Uint8Array(); this.init = []; this.parts = []; this.size = 0; this.version = 0; this.fragment = []; this.cluster = null; this.ready = false; this.timescale=null;this.timeStart=null; }
    save(part) {
      this.parts.push(part); this.size += part.length; this.version++;
      while (this.parts.length > 120 || this.size > 6 * 1024 * 1024) this.size -= this.parts.shift().length;
    }
    push(data) {
      if (data.length > 8 * 1024 * 1024) throw Error("audio segment too large");
      // Repeated initialization marks a codec/track change; never concatenate tracks.
      if (!this.pending.length && this.ready && ((this.webm && data[0] === 0x1a && data[1] === 0x45) ||
          (!this.webm && String.fromCharCode(...data.slice(4, 8)) === "ftyp"))) this.reset();
      this.pending = join([this.pending, data]);
      if (this.pending.length > 8 * 1024 * 1024) throw Error("incomplete audio segment too large");
      if (this.webm) this.readWebm(); else this.readMp4();
    }
    readMp4() {
      let at = 0;
      while (at + 8 <= this.pending.length) {
        const d = new DataView(this.pending.buffer, this.pending.byteOffset + at);
        let size = d.getUint32(0), header = 8;
        if (size === 1) { if (d.byteLength < 16) break; size = Number(d.getBigUint64(8)); header = 16; }
        if (size < header || size > 8 * 1024 * 1024) throw Error("invalid MP4 box");
        if (at + size > this.pending.length) break;
        const box = this.pending.slice(at, at + size), type = String.fromCharCode(...box.slice(4, 8));
        if (type === "ftyp" || type === "moov") {
          this.init.push(box);
          if(type==="moov") {
            this.ready=true;const mdhd=mp4Field(box,"mdhd");
            if(mdhd){const p=mdhd[0]===1?20:12;if(mdhd.length>=p+4)this.timescale=new DataView(mdhd.buffer,mdhd.byteOffset).getUint32(p);}
          }
        }
        else if (type === "moof") {
          this.fragment=[box];const tfdt=mp4Field(box,"tfdt");
          if(this.timeStart===null && this.timescale && tfdt && tfdt.length>=(tfdt[0]===1?12:8)) {
            const v=new DataView(tfdt.buffer,tfdt.byteOffset);
            this.timeStart=(tfdt[0]===1?Number(v.getBigUint64(4)):v.getUint32(4))/this.timescale;
          }
        }
        else if (type === "mdat" && this.fragment.length) { this.fragment.push(box); this.save(join(this.fragment)); this.fragment = []; }
        at += size;
      }
      this.pending = this.pending.slice(at);
    }
    readWebm() {
      let at = 0;
      while (at < this.pending.length) {
        const id = vint(this.pending, at, true); if (!id) break;
        const size = vint(this.pending, at + id.length); if (!size) break;
        const header = id.length + size.length, start = at + header;
        if (id.value === 0x18538067) { // Flatten Segment; rewrite size for a rolling snapshot.
          this.init.push(new Uint8Array([0x18,0x53,0x80,0x67,0x01,255,255,255,255,255,255,255])); at = start; continue;
        }
        if (this.cluster && [0x1f43b675,0x1c53bb6b,0x1549a966,0x1654ae6b].includes(id.value)) {
          this.save(join(this.cluster)); this.cluster = null;
        }
        if (id.value === 0x1f43b675 && size.unknown) {
          this.cluster = [this.pending.slice(at, start)]; at = start; continue;
        }
        if (size.unknown || size.value > 8 * 1024 * 1024) throw Error("unsupported EBML size");
        if (start + size.value > this.pending.length) break;
        const element = this.pending.slice(at, start + size.value);
        if (this.cluster) { this.cluster.push(element); this.version++; }
        else if (id.value === 0x1f43b675) this.save(element);
        else if ([0x1a45dfa3,0x1549a966,0x1654ae6b].includes(id.value)) {
          this.init.push(element); if (id.value === 0x1654ae6b) this.ready = true;
        }
        at = start + size.value;
      }
      this.pending = this.pending.slice(at);
      if (this.cluster && this.cluster.reduce((n,p)=>n+p.length,0) > 6*1024*1024) throw Error("cluster too large");
    }
    snapshot() {
      if (!this.ready || (!this.parts.length && !this.cluster)) return null;
      return join([...this.init, ...this.parts, ...(this.cluster || [])]);
    }
  }
  function selectSnapshot(items,time) {
    const timed=items.filter(x=>Number.isFinite(x.start)).sort((a,b)=>a.start-b.start);
    const selected=timed.filter(x=>x.start<=time+.03).at(-1) || timed[0] || items.at(-1);
    const next=selected?timed.find(x=>x.start>selected.start+.03):null;
    return {selected,nextStart:next?.start??null};
  }
  globalThis.TingjianMedia = { MediaAssembler, selectSnapshot };
})();
