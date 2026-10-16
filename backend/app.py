import asyncio
import json
import logging
import re
import secrets
import time
from contextlib import asynccontextmanager

import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .config import ROOT, Settings
from .engine import SpeechEngine
from .media import decode_segments, last_decode_stats
from .translation import BaiduTranslator, TranslationError

logger = logging.getLogger(__name__)
settings = Settings.load()
engine = SpeechEngine(settings)
translator = BaiduTranslator(settings)
gate = asyncio.Semaphore(1)
decode_gate = asyncio.Semaphore(1)
transcription_stats = []
local_settings = ROOT / ".local-settings.json"
if local_settings.exists():
    saved = json.loads(local_settings.read_text(encoding="utf-8"))
    settings.app_id = saved.get("app_id", settings.app_id)
    settings.secret = saved.get("secret", settings.secret)


@asynccontextmanager
async def lifespan(app):
    yield
    await translator.client.aclose()


app = FastAPI(title="YouTube 双语字幕本机服务", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origin_regex=r"chrome-extension://[a-p]{32}",
    allow_methods=["GET", "POST"], allow_headers=["Authorization", "Content-Type"],
)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "testserver"])


@app.middleware("http")
async def origin_guard(request, call_next):
    origin = request.headers.get("origin", "")
    if origin and not re.fullmatch(r"chrome-extension://[a-p]{32}", origin):
        from starlette.responses import JSONResponse
        return JSONResponse({"detail": "仅允许浏览器扩展访问"}, status_code=403)
    return await call_next(request)


def authorize(authorization: str = Header(default="")):
    if not secrets.compare_digest(authorization, f"Bearer {settings.token}"):
        raise HTTPException(401, "本机连接口令不正确，请复制服务窗口中的口令到扩展设置。")


@app.get("/health")
async def health():
    return {"ok": True, "version": "0.3.3", "model": settings.model, "device": settings.device,
            "compute_type": settings.compute_type, "model_ready": engine.model is not None,
            "translation_ready": bool(settings.app_id and settings.secret), "model_error": engine.error}


@app.get("/check", dependencies=[Depends(authorize)])
async def check():
    return await health()


@app.get("/diagnostics", dependencies=[Depends(authorize)])
async def diagnostics():
    return {"decode": dict(last_decode_stats), "transcriptions": list(transcription_stats)}


@app.post("/warmup", dependencies=[Depends(authorize)])
async def warmup():
    try:
        async with gate:
            await run_in_threadpool(engine.warmup)
    except Exception as exc:
        logger.exception("Model initialization failed")
        raise HTTPException(503, engine.error or "模型加载失败，请查看服务窗口。") from exc
    return {"ok": True}


class Credentials(BaseModel):
    app_id: str = Field(min_length=1, max_length=100)
    secret: str = Field(min_length=1, max_length=300)


@app.post("/credentials", dependencies=[Depends(authorize)])
async def credentials(data: Credentials):
    app_id, secret = data.app_id.strip(), data.secret.strip()
    if not app_id or not secret:
        raise HTTPException(422, "APP ID 和密钥不能为空。")
    # Verify before persisting, so a typo cannot overwrite working credentials.
    from dataclasses import replace
    probe = BaiduTranslator(replace(settings, app_id=app_id, secret=secret))
    try:
        translated = await probe.translate("Hello", "zh")
    except TranslationError as exc:
        raise HTTPException(400, str(exc)) from exc
    finally:
        await probe.client.aclose()
    temporary = local_settings.with_suffix(".tmp")
    temporary.write_text(json.dumps({"app_id": app_id, "secret": secret}), encoding="utf-8")
    temporary.replace(local_settings)
    settings.app_id, settings.secret = app_id, secret
    translator.cache.clear()
    return {"ok": True, "test_translation": translated}


@app.post("/transcribe", dependencies=[Depends(authorize)])
async def transcribe(request: Request, language: str = Query("auto", pattern=r"^(auto|[a-z]{2,3})$"),
                     target: str = Query("zh", pattern=r"^(zh|cht|en|jp|kor|fra|de|spa|ru)$"),
                     clip_start: float = Query(0, ge=0, le=12), clip_end: float = Query(12, gt=0, le=12)):
    if clip_end <= clip_start:
        raise HTTPException(422, "字幕所属音频范围无效。")
    if request.headers.get("content-type", "").split(";")[0] != "application/octet-stream":
        raise HTTPException(415, "需要 16 kHz 单声道 PCM16 音频。")
    audio = bytearray()
    async for chunk in request.stream():
        audio.extend(chunk)
        if len(audio) > 16000 * 2 * 12:
            raise HTTPException(413, "音频分段最多 12 秒。")
    if len(audio) < 3200 or len(audio) % 2:
        raise HTTPException(422, "PCM16 音频长度无效。")
    if gate.locked():
        raise HTTPException(429, "识别服务正在处理上一段音频，已跳过本段。")
    started = time.monotonic()
    samples = np.frombuffer(audio, dtype="<i2").astype(np.float32) / 32768.0
    async with gate:
        try:
            segments, detected = await run_in_threadpool(engine.transcribe, samples, language)
        except Exception as exc:
            logger.exception("Transcription failed")
            raise HTTPException(503, engine.error or "语音识别失败，请查看服务窗口。") from exc
        # Adjacent inputs overlap for recognition context. Each word belongs to
        # exactly one core window; exclude context words BEFORE translation.
        owned = []
        for segment in segments:
            if segment.get("words"):
                words = [w for w in segment["words"] if clip_start <= (w["start"]+w["end"])/2 < clip_end]
                if not words:
                    continue
                value = {"start": max(clip_start, words[0]["start"]), "end": min(clip_end, words[-1]["end"]),
                         "text": "".join(w["text"] for w in words).strip()}
            else:
                value = {"start": max(clip_start, segment["start"]), "end": min(clip_end, segment["end"]), "text": segment["text"]}
            if value["end"] > value["start"] and value["text"]:
                owned.append(value)
        segments = owned
        # One request with a paragraph per segment keeps timestamps attached to text.
        text = " ".join(s["text"] for s in segments)
        translated, warning, cues = "", None, []
        if text:
            try:
                translated = await translator.translate("\n".join(s["text"] for s in segments), target)
            except TranslationError as exc:
                warning = str(exc)
            lines = translated.splitlines() if translated else []
            if len(lines) == len(segments) or not translated:
                cues = [{**s, "translation": lines[i] if lines else ""} for i, s in enumerate(segments)]
            else:
                # Do not guess alignment if the provider changes paragraph count.
                cues = [{"start": segments[0]["start"], "end": segments[-1]["end"],
                         "text": text, "translation": translated}]
    core = samples[round(clip_start*16000):min(len(samples),round(clip_end*16000))]
    silence = bool(len(core) and float(np.sqrt(np.mean(core*core))) < .0005 and not text)
    transcription_stats.append({"audio_seconds":round(len(samples)/16000,3),"core":[clip_start,clip_end],
        "cue_ranges":[[c["start"],c["end"]] for c in cues],"silence":silence,
        "processing_ms":round((time.monotonic()-started)*1000)})
    del transcription_stats[:-8]
    return {"text": text, "translation": translated, "language": detected, "segments": segments, "cues": cues, "silence": silence,
            "warning": warning, "processing_ms": round((time.monotonic() - started) * 1000)}


@app.post("/decode", dependencies=[Depends(authorize)])
async def decode(request: Request, format: str = Query(pattern=r"^(mp4|webm)$"),
                 offset: float = Query(0, ge=-1e12, le=1e12),
                 start: float = Query(0, ge=0, le=1e12), end: float = Query(60, ge=0, le=1e12),
                 chunk: int = Query(4, ge=2, le=8), append_start: float = Query(0, ge=0, le=1e12),
                 append_end: float = Query(1e12, ge=0, le=1e12), context: float = Query(0, ge=0, le=1)):
    if not 0 < end-start <= 120.001:
        raise HTTPException(422, "一次最多读取 120 秒音频范围。")
    if request.headers.get("content-type", "").split(";")[0] != "application/octet-stream":
        raise HTTPException(415, "需要音频媒体分片。")
    if decode_gate.locked():
        raise HTTPException(429, "正在解码上一份音频分片。")
    payload = bytearray()
    async for block in request.stream():
        payload.extend(block)
        if len(payload) > 8*1024*1024:
            raise HTTPException(413, "音频快照最多 8 MB。")
    if not payload:
        raise HTTPException(422, "音频快照为空。")
    async with decode_gate:
        try:
            chunks = await run_in_threadpool(decode_segments, bytes(payload), format, offset, start, end, chunk, append_start, append_end, context)
        except Exception as exc:
            raise HTTPException(422, "音频分片尚不完整或无法读取时间戳，请等待新分片。") from exc
    return {"chunks": chunks}

