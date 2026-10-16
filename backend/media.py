"""Decode copied MSE audio bytes without touching playback or fetching URLs."""
import base64
import io
import math

import av
import numpy as np

last_decode_stats = {}


def decode_segments(data: bytes, format: str, offset: float, start: float, end: float,
                    chunk: int, append_start: float = 0, append_end: float = math.inf, context: float = 0):
    lower, upper = max(start, append_start), min(end, append_end)
    if upper <= lower:
        return []
    spans = []
    samples = []
    span_start = None
    expected = None
    gaps = []
    decoded_range = [math.inf, -math.inf]

    def flush():
        nonlocal samples, span_start, expected
        if samples:
            spans.append((span_start, np.concatenate(samples)))
        samples, span_start, expected = [], None, None

    # Explicit format and in-memory input: never resolve a page-supplied URL.
    with av.open(io.BytesIO(data), format="matroska" if format == "webm" else "mp4",
                 options={"protocol_whitelist": "file,pipe", "enable_drefs": "0"}) as container:
        if not container.streams.audio:
            raise ValueError("没有可解码的音轨")
        stream = container.streams.audio[0]
        resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
        decoded_count = 0

        def accept(frame):
            nonlocal span_start, expected
            if frame.pts is None or frame.time_base is None:
                raise ValueError("音频缺少呈现时间戳，无法对齐")
            t = float(frame.pts * frame.time_base) + offset
            a = frame.to_ndarray().reshape(-1)
            decoded_range[0] = min(decoded_range[0],t)
            decoded_range[1] = max(decoded_range[1],t+len(a)/16000)
            left = max(0, math.ceil((lower-t)*16000-1e-6))
            right = min(len(a), math.floor((upper-t)*16000+1e-6))
            if right <= left:
                return
            t += left / 16000
            a = a[left:right]
            # A discontinuity must never be collapsed into contiguous speech.
            if expected is not None and abs(t-expected) > 2/16000:
                gaps.append(t-expected)
                flush()
            if span_start is None:
                span_start = t
            samples.append(a.copy())
            expected = t + len(a)/16000

        try:
            for frame in container.decode(stream):
                decoded_count += 1
                if decoded_count > 30000:
                    raise ValueError("音频快照超出解码上限")
                for output in resampler.resample(frame):
                    accept(output)
            for output in resampler.resample(None):
                accept(output)
        except av.error.FFmpegError:
            # An MSE snapshot may end in a partial frame. Keep only frames that
            # were successfully decoded; do not fabricate a start time.
            if not samples and not spans:
                raise
        flush()
    result = []
    for origin, pcm in spans:
        at = 0
        while at < len(pcm):
            t = origin + at/16000
            boundary = (math.floor((t+1e-6)/chunk)+1)*chunk
            count = min(len(pcm)-at, max(1, round((boundary-t)*16000)))
            if count >= 1600:
                left = max(0, at-round(context*16000))
                right = min(len(pcm), at+count+round(context*16000))
                core_end = t+count/16000
                result.append({"start": origin+left/16000, "end": origin+right/16000,
                               "coreStart": t, "coreEnd": core_end,
                               "complete": core_end >= boundary-.002 and origin+len(pcm)/16000 >= boundary+context-.002,
                               "pcm": base64.b64encode(pcm[left:right].astype("<i2").tobytes()).decode("ascii")})
            at += count
    last_decode_stats.clear()
    last_decode_stats.update({"requested_start":start,"requested_end":end,"frames":decoded_count,
        "decoded_range":[round(t,4) if math.isfinite(t) else None for t in decoded_range],
        "span_count":len(spans),"span_seconds":[round(len(pcm)/16000,4) for _,pcm in spans[:12]],
        "span_ranges":[[round(origin,4),round(origin+len(pcm)/16000,4)] for origin,pcm in spans[:12]],
        "gap_seconds":[round(g,6) for g in gaps[:12]],"chunks":len(result),
        "complete_chunks":sum(c["complete"] for c in result)})
    return result
