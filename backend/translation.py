import asyncio
import hashlib
import secrets
import time
from collections import OrderedDict

import httpx

ERRORS = {
    "52001": "百度翻译请求超时", "52003": "百度翻译未授权，请检查 APP ID",
    "54001": "百度翻译签名错误，请检查密钥", "54003": "百度翻译请求过于频繁",
    "54004": "百度翻译账户余额不足", "54005": "百度翻译长文本请求频繁",
    "58001": "百度翻译不支持该语言方向", "58002": "百度翻译服务未开通",
    "90107": "百度翻译账户未认证或服务未开通",
}


class TranslationError(Exception):
    pass


def signature(app_id, text, salt, secret):
    return hashlib.md5((app_id + text + salt + secret).encode("utf-8")).hexdigest()


class BaiduTranslator:
    def __init__(self, settings, client=None):
        self.settings = settings
        self.client = client or httpx.AsyncClient(timeout=15)
        self.lock = asyncio.Lock()
        self.last_request = 0.0
        self.cache = OrderedDict()

    async def translate(self, text, target):
        if not self.settings.app_id or not self.settings.secret:
            raise TranslationError("尚未配置百度翻译 APP ID 和密钥，请打开扩展设置。")
        if len(text.encode("utf-8")) > 5800:
            raise TranslationError("单段文字过长，超过百度翻译请求长度限制。")
        key = (text, target)
        async with self.lock:
            if key in self.cache:
                self.cache.move_to_end(key)
                return self.cache[key]
            for attempt in range(3):
                await asyncio.sleep(max(0, self.settings.translation_interval - (time.monotonic() - self.last_request)))
                salt = secrets.token_hex(12)
                self.last_request = time.monotonic()
                try:
                    response = await self.client.post(
                        "https://fanyi-api.baidu.com/api/trans/vip/translate",
                        data={"q": text, "from": "auto", "to": target,
                              "appid": self.settings.app_id, "salt": salt,
                              "sign": signature(self.settings.app_id, text, salt, self.settings.secret)},
                    )
                    response.raise_for_status()
                    data = response.json()
                except (httpx.HTTPError, ValueError) as exc:
                    if attempt < 2:
                        await asyncio.sleep(1 + attempt)
                        continue
                    raise TranslationError("无法连接百度翻译，请检查网络。") from exc
                code = str(data.get("error_code", ""))
                if code in {"52001", "54003", "54005"} and attempt < 2:
                    await asyncio.sleep(1 + attempt)
                    continue
                if "error_code" in data:
                    raise TranslationError(ERRORS.get(code, f"百度翻译返回错误 {code}"))
                try:
                    translated = "\n".join(item["dst"] for item in data["trans_result"])
                    if not translated:
                        raise ValueError("empty translation")
                except (KeyError, TypeError, ValueError) as exc:
                    raise TranslationError("百度翻译返回了无效结果。") from exc
                self.cache[key] = translated
                if len(self.cache) > 1000:
                    self.cache.popitem(last=False)
                return translated

