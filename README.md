# 听见 · YouTube 直播实时翻译

专用于 Microsoft Edge 中的 **YouTube 直播实时翻译**，生成原文与译文双语字幕：使用本机 **Whisper large-v3-turbo** 识别语音，再调用 **百度通用翻译 API** 翻译文字。

当前版本：**0.3.3**。**源码公开，限非商业使用**，采用 [PolyForm Noncommercial License 1.0.0](LICENSE)。商业用途需另行获得授权，具体允许范围以许可证为准。

## 功能

- 适用于正在进行的 YouTube 直播；直播提供暂停、回看功能时可继续匹配字幕，同一时刻处理一个直播标签页。
- 保持 YouTube 原播放器的画面、声音、音量、暂停和倍速行为。
- 从播放器已经下载的音频分片中读取当前位置及未来最多 60 秒的音频。
- 根据媒体时间戳显示字幕，收到的字幕缓存 60 秒；后退时优先使用有效缓存。
- 支持原文与译文、字号、字幕高度、播放器全屏和处理步长设置。
- 优先使用 NVIDIA GPU，也可切换 CPU 模式。

没有固定的 10 秒播放延迟，也不能读取尚未产生的直播内容。可提前处理多少音频取决于 YouTube 实际下载进度。

## 环境要求

- Windows，较新的 Microsoft Edge（Chromium 内核 116 或更高）。
- Python 3.10 或更高版本，命令行中可运行 `python`。
- NVIDIA GPU 模式需要兼容 CUDA 12 的驱动；相关运行库由项目脚本安装到虚拟环境。
- 自行申请的百度通用翻译 API APP ID 和密钥。
- 首次安装及下载模型需要网络；翻译服务按你的百度账户规则计费。

仓库不包含 API 凭据、模型权重、Python 环境或媒体样本。

## 安装

### 1. 获取项目

下载本仓库 ZIP 并解压，或使用 Git：

```powershell
git clone https://github.com/JD-SkQ/tingjian-youtube-subtitles.git
cd tingjian-youtube-subtitles
```

后续命令均在项目根目录运行。

### 2. 安装服务依赖

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
```

使用 NVIDIA GPU 时，再运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup-gpu.ps1
```

脚本会创建 `.venv`，并从 `.env.example` 创建本机 `.env`。默认配置为 CUDA 与 `int8_float16`。

无 NVIDIA GPU 时，跳过 GPU 安装，并在 `.env` 中修改：

```dotenv
WHISPER_DEVICE=cpu
WHISPER_COMPUTE_TYPE=int8
```

CPU 识别速度取决于硬件，可能无法跟上实时播放。

### 3. 启动本机服务

双击 **启动字幕服务.cmd**，或运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
```

保持服务窗口运行。服务默认监听 `http://127.0.0.1:8765`，首次运行自动生成连接口令并显示在窗口中。

### 4. 加载 Edge 扩展

1. 在 Edge 打开 `edge://extensions`。
2. 开启“开发人员模式”。
3. 点击“加载解压缩的扩展”，选择项目中的 `extension` 文件夹。
4. 打开「听见」的“设置”，填写服务窗口中的本机连接口令并保存。
5. 填入自己的百度 APP ID 和密钥，点击“验证并保存翻译凭据”。
6. 点击“准备模型”，首次使用等待权重下载及模型加载完成。

百度凭据也可通过 `.env` 配置；通过设置页保存的 `.local-settings.json` 中的值优先使用。

### 5. 开启或关闭字幕

打开或刷新正在进行的 YouTube 直播页，开始播放后，**先将直播进度向后拖动一点，再开启字幕翻译**。然后点击 Edge 扩展菜单中的「听见」，点击 **开始字幕翻译**。

> **使用备注：观看时间需要先后退一点，不要紧贴直播最前沿。** 这样可为音频识别和翻译留出处理时间，减少字幕晚到或断档。后退幅度可根据实际字幕效果调整；直播需提供回看功能。

关闭字幕时点击 **停止字幕翻译**。完全退出服务时，在服务窗口按 `Ctrl+C`。电脑重启后，需要重新启动服务。

更新扩展文件后，在 `edge://extensions` 重新加载「听见」，再刷新 YouTube 页面，使分片读取器在播放器初始化之前安装。

## 字幕时间与缓存

音频帧时间戳与 `SourceBuffer.timestampOffset` 共同映射到视频时间。扩展按播放位置选取音频快照，保留重复初始化前的分片，避免新下载的未来片段覆盖当前观看位置的音频。

独立音频时间线合并相邻分片，为每个识别区间提供前后各最多 1 秒上下文。Whisper 的词级时间用于确定字幕所属区间，然后翻译并显示。

当前时间命中字幕时优先显示对应句子。识别暂时断档时，最近已播放字幕可保留到其结束后最多 6 秒；下一句到点立即替换。明确静音时清空字幕，不将未来字幕提前显示。

暂停可继续处理已经下载的音频。后退优先匹配尚未到期的字幕；音频被淘汰后，需要等待 YouTube 重新下载。广告、切换直播或重启翻译会清理上下文。

## 支持范围与限制

- **仅面向 YouTube 直播实时翻译。普通点播视频、直播结束后的录像回放和其他网站不在支持范围内。** 正在进行的直播所提供的暂停与回看功能仍可使用。

- 支持主页面 MediaSource 的 MP4/AAC、WebM/Opus 独立音轨；`SourceBuffer.mode` 需要为 `segments`，并具有有效时间戳。
- 暂不支持受保护媒体、Worker 内创建的 MediaSource、非 MSE 播放、混合音视频 SourceBuffer 及不兼容媒体格式。
- 暂不支持原生画中画字幕、SRT 导出或说话人区分。
- 识别和翻译可能存在漏字、重复、分句及时间误差。短时直播验证不能代表所有直播或长时间稳定性。
- 直播最前沿、网络停滞或识别速度不足时，字幕仍可能晚到。

## 隐私与配置

语音在本机解码和识别，识别出的文字发送到百度翻译。启用翻译后，扩展将选定标签页的音频分片发送到本机服务；页面运行期间会在内存中暂存有限数量的分片。

`.env` 中的连接口令与 `.local-settings.json` 中的百度凭据为本机配置，均由 `.gitignore` 排除。不要上传这些文件、服务日志或带有口令的截图。配置示例中的凭据保持空白，每位使用者应填写自己的凭据。

服务只绑定回环地址，并检查连接口令、Host 和浏览器 Origin。诊断接口返回音频时长、时间范围、分段数及处理耗时，不保存音频或字幕文本。测试和手动诊断产生的数据位于忽略目录 `test-results`。

## 排障

| 现象 | 检查方法 |
| --- | --- |
| 扩展显示连接未就绪 | 确认服务窗口正在运行、端口未被其他程序占用，且连接口令填写正确。 |
| 模型加载失败 | 检查下载网络、NVIDIA 驱动和 GPU 运行库；也可修改 `.env` 切换 CPU 后重启服务。 |
| 未收到音频分片 | 刷新 YouTube 页面，播放并等待下载；不兼容媒体格式可能无法读取。 |
| 有原文但无译文 | 检查百度凭据、账户额度和翻译服务状态。 |
| 字幕晚到或断档 | 检查网络、GPU 是否启用、处理耗时，以及直播是否处于最前沿。 |

## 开发与测试

JavaScript 测试需安装支持 `node --test` 的 Node.js（建议 Node.js 22 或更高），无需 npm 依赖。

```powershell
.\.venv\Scripts\python.exe -m pip install -r backend/requirements-dev.txt
.\.venv\Scripts\python.exe -m pytest -q
npm test
.\.venv\Scripts\python.exe -m playwright install chromium
.\.venv\Scripts\python.exe tests/browser_check.py
.\.venv\Scripts\python.exe tests/sync_browser.py
```

浏览器测试使用隔离的 Chromium，不依赖个人浏览器配置。单元测试模拟识别与翻译，不需要真实百度凭据。

`tests/gpu_smoke.py`、`tests/alignment_smoke.py` 和 `tests/prefetch_smoke.py` 接受自行提供的语音文件；后两者需要正在运行且配置完毕的服务，并会调用百度翻译。运行前创建 `test-results` 目录。不要将个人录音或测试输出提交到仓库。

## License

本项目原创源码采用 **PolyForm Noncommercial License 1.0.0**，允许许可证规定范围内的非商业使用、修改和分发。分发时须保留许可证及 [NOTICE](NOTICE) 要求的声明。商业用途需另行取得授权。

完整条款见 [LICENSE](LICENSE)。依赖库、单独下载的模型权重及第三方服务分别适用各自的许可证和条款，本项目的许可证不改变这些条款。
