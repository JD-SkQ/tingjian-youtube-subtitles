"""Explicit live-service smoke test: media bytes -> timestamps -> GPU -> Baidu."""
import base64
import io
import json
import sys
from fractions import Fraction
from pathlib import Path

import av
import httpx
import numpy as np
from dotenv import dotenv_values
from faster_whisper.audio import decode_audio

root=Path(__file__).resolve().parents[1]
audio=decode_audio(sys.argv[1],sampling_rate=16000)
media=io.BytesIO()
with av.open(media,"w",format="mp4",options={"movflags":"frag_keyframe+empty_moov+default_base_moof","frag_duration":"1000000"}) as out:
    stream=out.add_stream("aac",rate=16000);stream.layout="mono"
    for at in range(0,len(audio),1024):
        f=av.AudioFrame.from_ndarray(audio[None,at:at+1024].astype(np.float32),format="flt",layout="mono")
        f.sample_rate=16000;f.pts=at;f.time_base=Fraction(1,16000)
        for packet in stream.encode(f):out.mux(packet)
    for packet in stream.encode():out.mux(packet)
token=dotenv_values(root/".env")["LOCAL_API_TOKEN"]
with httpx.Client(base_url="http://127.0.0.1:8765",headers={"Authorization":f"Bearer {token}"},timeout=120) as client:
    decoded=client.post("/decode?format=mp4&offset=100&start=100&end=112&chunk=4&context=1",content=media.getvalue(),headers={"Content-Type":"application/octet-stream"})
    decoded.raise_for_status()
    results=[]
    for chunk in decoded.json()["chunks"]:
        result=client.post("/transcribe",params={"language":"en","target":"zh",
            "clip_start":chunk["coreStart"]-chunk["start"],"clip_end":chunk["coreEnd"]-chunk["start"]},
            content=base64.b64decode(chunk["pcm"]),headers={"Content-Type":"application/octet-stream"})
        result.raise_for_status();data=result.json()
        assert not data["warning"],data
        if data["text"]: assert data["translation"],data
        data["cues"]=[{**c,"start":c["start"]+chunk["start"],"end":c["end"]+chunk["start"]} for c in data["cues"]]
        assert all(chunk["coreStart"]-.001<=c["start"]<c["end"]<=chunk["coreEnd"]+.001 for c in data["cues"])
        results.append({"core":[chunk["coreStart"],chunk["coreEnd"]],"processing_ms":data["processing_ms"],"cues":data["cues"]})
    assert any(r["cues"] for r in results)
    (root/"test-results/prefetch-smoke.json").write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps({"ok":True,"results":results},ensure_ascii=True))
