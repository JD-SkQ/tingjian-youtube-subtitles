import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient

from backend import app as module
from backend.config import Settings
from backend.translation import BaiduTranslator, TranslationError, signature


@pytest.fixture
def client():
    return TestClient(module.app)


@pytest.fixture
def headers():
    return {"Authorization": f"Bearer {module.settings.token}", "Content-Type": "application/octet-stream"}


def test_health_and_authorization(client, headers):
    assert client.get("/health").status_code == 200
    assert client.get("/check").status_code == 401
    assert client.get("/check", headers=headers).status_code == 200
    assert client.get("/diagnostics").status_code == 401
    assert client.get("/diagnostics", headers=headers).status_code == 200
    assert client.post("/warmup").status_code == 401
    assert client.post("/credentials", json={"app_id": "a", "secret": "b"}).status_code == 401


def test_reject_browser_pages_and_host_rebinding(client, headers):
    assert client.get("/health", headers={"Origin": "https://www.youtube.com"}).status_code == 403
    assert client.get("/health", headers={"Host": "evil.example"}).status_code == 400
    assert client.get("/check", headers={**headers, "Origin": "chrome-extension://" + "a" * 32}).status_code == 200


def test_pcm_validation(client, headers):
    assert client.post("/transcribe", headers=headers, content=b"1").status_code == 422
    assert client.post("/transcribe", headers=headers, content=bytes(384002)).status_code == 413
    assert client.post("/transcribe", headers={"Authorization": headers["Authorization"]}, content=bytes(4000)).status_code == 415
    assert client.post("/transcribe?target=auto", headers=headers, content=bytes(4000)).status_code == 422


def test_transcription_and_translation_warning(client, headers, monkeypatch):
    fake = Mock()
    fake.transcribe.return_value = ([{"start": 0.2, "end": 1.5, "text": "Hello world"}], "en")
    monkeypatch.setattr(module, "engine", fake)
    translate = AsyncMock(side_effect=TranslationError("百度翻译账户余额不足"))
    monkeypatch.setattr(module, "translator", SimpleNamespace(translate=translate))
    pcm = (np.ones(32000) * 16384).astype("<i2").tobytes()
    response = client.post("/transcribe?language=en", headers=headers, content=pcm)
    assert response.status_code == 200
    assert response.json()["text"] == "Hello world"
    assert response.json()["translation"] == ""
    assert "余额不足" in response.json()["warning"]
    assert np.isclose(fake.transcribe.call_args.args[0][0], 0.5)
    assert fake.transcribe.call_args.args[1] == "en"


def test_success_uses_one_translation_per_chunk(client, headers, monkeypatch):
    engine = Mock()
    engine.transcribe.return_value = ([{"start": 0, "end": 1, "text": "Hello."}, {"start": 1, "end": 2, "text": "World."}], "en")
    translate = AsyncMock(return_value="你好。世界。")
    monkeypatch.setattr(module, "engine", engine)
    monkeypatch.setattr(module, "translator", SimpleNamespace(translate=translate))
    response = client.post("/transcribe", headers=headers, content=bytes(64000))
    assert response.json()["translation"] == "你好。世界。"
    translate.assert_awaited_once_with("Hello.\nWorld.", "zh")
    assert response.json()["cues"] == [{"start": 0, "end": 2, "text": "Hello. World.", "translation": "你好。世界。"}]


def test_segment_translations_keep_their_own_timestamps(client, headers, monkeypatch):
    engine = Mock()
    engine.transcribe.return_value = ([{"start": 0.3, "end": 1.1, "text": "Hello."}, {"start": 2, "end": 3, "text": "World."}], "en")
    monkeypatch.setattr(module, "engine", engine)
    monkeypatch.setattr(module, "translator", SimpleNamespace(translate=AsyncMock(return_value="你好。\n世界。")))
    result = client.post("/transcribe", headers=headers, content=bytes(128000)).json()
    assert result["cues"] == [{"start": 0.3, "end": 1.1, "text": "Hello.", "translation": "你好。"},
                              {"start": 2, "end": 3, "text": "World.", "translation": "世界。"}]


def test_busy_service_rejects_instead_of_backlogging(client, headers, monkeypatch):
    busy = asyncio.Semaphore(0)
    monkeypatch.setattr(module, "gate", busy)
    assert client.post("/transcribe", headers=headers, content=bytes(4000)).status_code == 429


def test_baidu_signature_official_example():
    assert signature("2015063000000001", "apple", "1435660288", "12345678") == "f89f9594663708c1605f3d736d01d2d4"


def test_context_words_are_excluded_before_translation(client, headers, monkeypatch):
    engine=Mock()
    engine.transcribe.return_value=([{"start":0,"end":4,"text":"before core after", "words":[
        {"start":.1,"end":.5,"text":"before"}, {"start":1.2,"end":2.2,"text":" core"},
        {"start":3.1,"end":3.8,"text":" after"}]}],"en")
    translate=AsyncMock(return_value="核心")
    monkeypatch.setattr(module,"engine",engine)
    monkeypatch.setattr(module,"translator",SimpleNamespace(translate=translate))
    result=client.post("/transcribe?clip_start=1&clip_end=3",headers=headers,content=bytes(128000)).json()
    assert result["cues"] == [{"start":1.2,"end":2.2,"text":"core","translation":"核心"}]
    translate.assert_awaited_once_with("core","zh")


def test_no_recognition_is_not_assumed_to_be_silence(client,headers,monkeypatch):
    engine=Mock();engine.transcribe.return_value=([],"en")
    monkeypatch.setattr(module,"engine",engine)
    pcm=(np.ones(16000)*1000).astype("<i2").tobytes()
    assert client.post("/transcribe",headers=headers,content=pcm).json()["silence"] is False
    assert client.post("/transcribe",headers=headers,content=bytes(32000)).json()["silence"] is True


def test_translation_posts_utf8_and_caches():
    async def run():
        calls = []

        def handle(request):
            calls.append(request)
            return httpx.Response(200, json={"trans_result": [{"src": "Hello 世界", "dst": "你好世界"}]})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http_client:
            translator = BaiduTranslator(Settings("test", app_id="app", secret="secret", translation_interval=0), http_client)
            assert await translator.translate("Hello 世界", "zh") == "你好世界"
            assert await translator.translate("Hello 世界", "zh") == "你好世界"
            assert len(calls) == 1
            assert b"q=Hello+%E4%B8%96%E7%95%8C" in calls[0].content

    asyncio.run(run())


def test_translation_rejects_credentials_and_api_errors():
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"error_code": "54001"}))) as http_client:
            translator = BaiduTranslator(Settings("test", app_id="a", secret="bad", translation_interval=0), http_client)
            with pytest.raises(TranslationError, match="签名错误"):
                await translator.translate("hello", "zh")
            translator.settings.secret = ""
            with pytest.raises(TranslationError, match="尚未配置"):
                await translator.translate("hello", "zh")
    asyncio.run(run())
