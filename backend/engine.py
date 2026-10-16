"""Lazy model initialization; CUDA DLL lookup also supports an existing PyTorch install."""
import importlib.util
import os
import site
import threading
from pathlib import Path

import numpy as np

_dll_handles = []


def prepare_cuda():
    if os.name != "nt":
        return
    candidates = [Path(os.environ["CUDA_PATH"]) / "bin"] if os.getenv("CUDA_PATH") else []
    # Some Windows users already have cuBLAS/cuDNN installed with PyTorch.
    spec = importlib.util.find_spec("torch")
    if spec and spec.origin:
        candidates.append(Path(spec.origin).parent / "lib")
    # NVIDIA's Windows pip wheels contain DLLs in nvidia/*/bin.
    for packages in site.getsitepackages():
        nvidia = Path(packages) / "nvidia"
        for component in ("cublas", "cudnn", "cuda_runtime", "cuda_nvrtc"):
            candidates.append(nvidia / component / "bin")
    extra = os.getenv("CUDA_DLL_DIRECTORY", "")
    if extra:
        candidates.insert(0, Path(extra))
    for directory in candidates:
        if directory.is_dir():
            os.environ["PATH"] = str(directory) + os.pathsep + os.environ.get("PATH", "")
            _dll_handles.append(os.add_dll_directory(str(directory)))


class SpeechEngine:
    def __init__(self, settings):
        self.settings = settings
        self.model = None
        self.error = None
        self.lock = threading.Lock()

    def warmup(self):
        with self.lock:
            self._load()

    def _load(self):
        if self.model is None:
            try:
                prepare_cuda()
                from faster_whisper import WhisperModel

                self.model = WhisperModel(
                    self.settings.model,
                    device=self.settings.device,
                    compute_type=self.settings.compute_type,
                    download_root=str(Path(__file__).resolve().parents[1] / "models"),
                )
                # Run inference too: CUDA/cuDNN errors can occur after model construction.
                list(self.model.transcribe(np.zeros(16000, dtype=np.float32), beam_size=1)[0])
                self.error = None
            except Exception:
                self.model = None
                self.error = "模型加载失败。检查模型下载网络及 CUDA 12 / cuDNN 9，或在 .env 切换 CPU。"
                raise

    def transcribe(self, samples, language):
        with self.lock:
            self._load()
            segments, info = self.model.transcribe(
                samples,
                language=None if language == "auto" else language,
                task="transcribe",
                beam_size=1,
                word_timestamps=True,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 400},
                condition_on_previous_text=False,
            )
            result = []
            duration = len(samples) / 16000
            for s in segments:
                # faster-whisper already combines speech probability and text
                # confidence when skipping silence. Do not discard its accepted
                # words again based on speech probability alone.
                if not s.text.strip():
                    continue
                words = [w for w in (s.words or []) if w.word.strip() and w.end > w.start]
                start = max(0.0, float(words[0].start if words else s.start))
                end = min(duration, float(words[-1].end if words else s.end))
                if end > start:
                    result.append({"start": start, "end": end, "text": s.text.strip(),
                                   "words": [{"start": float(w.start), "end": float(w.end), "text": w.word} for w in words]})
            return result, info.language

