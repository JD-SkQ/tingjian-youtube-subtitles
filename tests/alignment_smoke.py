"""Real-service timing regression: prepend silence, expect shifted speech cues."""
import json
import sys
from pathlib import Path

import httpx
import numpy as np
from dotenv import dotenv_values
from faster_whisper.audio import decode_audio

root=Path(__file__).resolve().parents[1]
samples=decode_audio(sys.argv[1],sampling_rate=16000)[:8*16000]
headers={"Authorization":"Bearer "+dotenv_values(root/".env")["LOCAL_API_TOKEN"],
         "Content-Type":"application/octet-stream"}
results=[]
with httpx.Client(base_url="http://127.0.0.1:8765",headers=headers,timeout=120) as client:
    for silence in [0,2]:
        audio=np.concatenate([np.zeros(silence*16000),samples])
        response=client.post("/transcribe?language=en&target=zh",content=(np.clip(audio,-1,1)*32767).astype("<i2").tobytes())
        response.raise_for_status()
        data=response.json();assert data["cues"],data
        results.append({"silence":silence,"start":data["cues"][0]["start"],
                        "end":data["cues"][-1]["end"],"processing_ms":data["processing_ms"]})
shift=results[1]["start"]-results[0]["start"]
assert abs(shift-2)<.35,results
assert abs(results[1]["end"]-results[0]["end"]-2)<.35,results
(root/"test-results/alignment-smoke.json").write_text(json.dumps(results,indent=2),encoding="utf-8")
print(json.dumps({"ok":True,"measured_shift":shift,"results":results}))
