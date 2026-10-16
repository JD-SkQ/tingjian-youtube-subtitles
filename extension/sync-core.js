(() => {
  class SubtitleCache {
    constructor(ttl = 60000) { this.ttl = ttl; this.clear(); }
    clear() { this.cues = []; this.latest = null; this.coverage = []; }
    prune(now) {
      this.cues = this.cues.filter(c => now - c.received < this.ttl);
      this.coverage = this.coverage.filter(r => now-r.received < this.ttl);
      if (this.latest && now - this.latest.received >= this.ttl) this.latest = null;
    }
    add(cues, now = Date.now(), range = null) {
      this.prune(now);
      const valid = cues.filter(c => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end>c.start && (c.text || c.translation));
      if (range && (valid.length || range.silence===true) && Number.isFinite(range.start) && Number.isFinite(range.end) && range.end>range.start) {
        // Growing tail chunks are recognized again when more bytes arrive.
        // Replace their older hypotheses rather than mixing both timelines.
        this.cues = this.cues.filter(c => c.end<=range.start || c.start>=range.end);
        this.coverage = this.coverage.filter(r => r.start<range.start || r.end>range.end);
        this.coverage.push({...range,received:now});
        this.coverage = this.coverage.slice(-1000);
      }
      for (const cue of valid) {
        const fresh = { ...cue, received: now };
        this.cues = this.cues.filter(c => Math.abs(c.start - cue.start) > .03 || Math.abs(c.end - cue.end) > .03);
        this.cues.push(fresh); this.latest = fresh;
      }
      this.cues.sort((a,b) => a.start - b.start);
      if (this.cues.length > 1000) this.cues = this.cues.slice(-1000);
    }
    at(time, now = Date.now()) {
      this.prune(now);
      const cue = this.cues.filter(c => c.start <= time && time < c.end).sort((a,b) => b.received-a.received || b.start-a.start)[0];
      if (cue) return { cue, aligned: true };
      // Only measured near-zero audio is confirmed silence. Recognition gaps
      // in an otherwise spoken segment must not forcibly blank the display.
      if (this.isSilent(time)) return null;
      // Prefetch completion is not playback time: never show a future sentence
      // merely because it was the latest result to arrive. Bound late fallback
      // in both media time and wall time, so gaps/seeks cannot resurrect old text.
      const recent = this.cues.filter(c => c.end <= time && time-c.end <= 6)
        .sort((a,b) => b.end-a.end || b.received-a.received)[0];
      return recent ? { cue: recent, aligned: false } : null;
    }
    isSilent(time) {return this.coverage.some(r=>r.silence===true && r.start<=time && time<r.end);}
  }
  class SubtitlePresenter {
    constructor() { this.reset(); }
    reset() { this.current=null;this.since=0; }
    at(match,time,now=performance.now(),silence=false) {
      if(silence){this.reset();return null;}
      if (match) {
        const a=this.current?.cue,b=match.cue;
        if (!a || a.start!==b.start || a.end!==b.end || a.text!==b.text || a.translation!==b.translation) this.since=now;
        this.current=match;
        return match;
      }
      const cue=this.current?.cue;
      // A late result should be readable, but never hold it across a seek,
      // before its own start, or in preference to the next aligned sentence.
      if (cue && time>=cue.start && time<=cue.end+6 && now-this.since<8000) return this.current;
      this.reset();return null;
    }
  }
  globalThis.TingjianSync = { SubtitleCache, SubtitlePresenter };
})();
