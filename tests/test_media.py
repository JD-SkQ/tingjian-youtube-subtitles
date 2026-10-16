import base64
import io
from fractions import Fraction

import av
import numpy as np
import pytest
from fastapi.testclient import TestClient

from backend.app import app, settings
from backend.media import decode_segments


def fixture_bytes(format, seconds=12):
    out = io.BytesIO()
    options = {"movflags": "frag_keyframe+empty_moov+default_base_moof", "frag_duration": "1000000"} if format == "mp4" else {"cluster_time_limit": "1000"}
    with av.open(out, "w", format=format, options=options) as container:
        stream = container.add_stream("aac" if format == "mp4" else "libopus", rate=48000)
        stream.layout = "mono"
        for at in range(0, seconds*48000, 960):
            a = (.3*np.sin(2*np.pi*440*np.arange(at, at+960)/48000)).astype("float32")[None, :]
            frame = av.AudioFrame.from_ndarray(a, format="flt", layout="mono")
            frame.sample_rate=48000; frame.pts=at; frame.time_base=Fraction(1,48000)
            for packet in stream.encode(frame): container.mux(packet)
        for packet in stream.encode(): container.mux(packet)
    return out.getvalue()


@pytest.mark.parametrize("format", ["mp4", "webm"])
def test_real_decode_timestamp_offset_and_window(format):
    data = fixture_bytes(format)
    chunks = decode_segments(data, format, 100, 103, 109, 4, 103.5, 108.5)
    assert chunks and chunks[0]["start"] == pytest.approx(103.5, abs=.001)
    assert chunks[-1]["end"] == pytest.approx(108.5, abs=.001)
    assert all(a["end"] == pytest.approx(b["start"], abs=.001) for a,b in zip(chunks,chunks[1:]))
    for c in chunks:
        pcm=np.frombuffer(base64.b64decode(c["pcm"]),dtype="<i2")
        assert len(pcm)/16000 == pytest.approx(c["end"]-c["start"])
        assert np.sqrt(np.mean((pcm.astype(float)/32768)**2)) > .1


def test_decode_endpoint_validation_and_authentication():
    client=TestClient(app)
    headers={"Authorization":f"Bearer {settings.token}","Content-Type":"application/octet-stream"}
    assert client.post("/decode?format=mp4").status_code == 401
    for query in ["format=mp4&offset=NaN", "format=mp4&end=121", "format=hls", "format=mp4&start=9&end=4"]:
        assert client.post("/decode?"+query,headers=headers,content=b"bad").status_code == 422
    assert client.post("/decode?format=mp4",headers=headers,content=b"bad").status_code == 422
    result=client.post("/decode?format=webm&offset=30&start=30&end=34",headers=headers,content=fixture_bytes("webm",4))
    assert result.status_code==200
    assert result.json()["chunks"][0]["start"] >= 30


def test_context_windows_have_unique_cores_and_mark_unfinished_tails():
    chunks=decode_segments(fixture_bytes("mp4",10),"mp4",0,0,12,4,context=1)
    middle=next(c for c in chunks if abs(c["coreStart"]-4)<.01)
    assert middle["coreEnd"] == pytest.approx(8)
    assert middle["start"] == pytest.approx(3)
    assert middle["end"] == pytest.approx(9)
    assert middle["complete"] is True
    assert len(base64.b64decode(middle["pcm"]))/32000 == pytest.approx(6)
    assert chunks[-1]["complete"] is False
    assert all(a["coreEnd"] == pytest.approx(b["coreStart"]) for a,b in zip(chunks,chunks[1:]))
