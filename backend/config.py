import os
import secrets
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]


@dataclass
class Settings:
    token: str
    model: str = "large-v3-turbo"
    device: str = "cuda"
    compute_type: str = "int8_float16"
    app_id: str = ""
    secret: str = ""
    translation_interval: float = 1.05

    @classmethod
    def load(cls):
        load_dotenv(ROOT / ".env")
        token = os.getenv("LOCAL_API_TOKEN", "").strip()
        if not token:
            token = secrets.token_urlsafe(32)
            with (ROOT / ".env").open("a", encoding="utf-8") as file:
                file.write(f"\nLOCAL_API_TOKEN={token}\n")
        return cls(
            token=token,
            model=os.getenv("WHISPER_MODEL", "large-v3-turbo"),
            device=os.getenv("WHISPER_DEVICE", "cuda"),
            compute_type=os.getenv("WHISPER_COMPUTE_TYPE", "int8_float16"),
            app_id=os.getenv("BAIDU_APP_ID", ""),
            secret=os.getenv("BAIDU_SECRET_KEY", ""),
            translation_interval=float(os.getenv("BAIDU_INTERVAL", "1.05")),
        )

