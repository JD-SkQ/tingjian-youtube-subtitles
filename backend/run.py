import uvicorn

from .app import settings

if __name__ == "__main__":
    print("\nYouTube 双语字幕本机服务", flush=True)
    print("服务地址：http://127.0.0.1:8765", flush=True)
    print(f"本机连接口令（复制到扩展设置）：{settings.token}", flush=True)
    print(f"模型：{settings.model} / {settings.device} / {settings.compute_type}", flush=True)
    print("首次准备模型会下载权重，请保持网络连接。关闭本窗口将停止服务。\n", flush=True)
    uvicorn.run("backend.app:app", host="127.0.0.1", port=8765, log_level="info")

