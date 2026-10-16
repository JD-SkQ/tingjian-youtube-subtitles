r"""Run against a short local speech file: .venv\Scripts\python tests/gpu_smoke.py audio.wav"""
import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from faster_whisper.audio import decode_audio
from backend.app import engine


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio", type=Path)
    parser.add_argument("--language", default="en")
    args = parser.parse_args()
    samples = decode_audio(str(args.audio), sampling_rate=16000)
    engine.warmup()
    start = time.monotonic()
    segments, language = engine.transcribe(samples, args.language)
    result = {"device": engine.settings.device, "model": engine.settings.model,
              "audio_seconds": round(len(samples) / 16000, 2),
              "inference_seconds": round(time.monotonic() - start, 2), "language": language,
              "text": " ".join(segment["text"] for segment in segments)}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not result["text"]:
        raise SystemExit("No speech recognized; use an audible speech recording.")


if __name__ == "__main__":
    main()
