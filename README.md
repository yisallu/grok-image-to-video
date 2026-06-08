# Grok 图生视频 Chrome 扩展

> **Alt + 左键点击**网页上任意图片(或暂停的视频帧),先弹出提示词框供本次微调,确认后通过 `https://api.5203333.xyz` 调用 xAI **Grok Imagine** 图生视频,在**新标签页**显示进度并播放结果。仍兼容旧 `/i2v` 代理模式,用于服务端代抓防盗链图片和 Telegram 存档。

---

## ✨ 功能

- **Alt + 左键点图先确认提示词**：点图后会弹出提示词框,可微调本次提示词;点「生成视频」后在新标签页显示排队/生成进度,完成后直接播放视频(可下载、看原始链接)。
- **视频关键帧续写**：**暂停任意视频**后 Alt+左键点它,以**当前帧**为源图再生成一段;在结果页同样可对生成的视频继续续写,续写前也会弹出提示词框。
- **左/右 Alt 两套提示词**：左 Alt 用提示词 A,右 Alt 用提示词 B,弹窗内确认的改动会同步回设置与历史。
- **保持原图比例不拉伸**：自动选最接近的受支持比例,并把原图按原比例居中、四周补黑边(letterbox)——画面**绝不拉伸变形**。
- **任意图片来源**：普通网页图、跨域防盗链图(各类 booru 站)、**抖音图文多图**(穿透透明覆盖层、跳过占位层、抓当前显示的那张)、本地图片/视频。
- **并发 + 排队**：一次点多张,按设定并发数(默认 3)逐批处理,其余自动排队;遇上游限流自动退避重试;关掉进度页自动释放并发槽。
- **Telegram 推送(可选)**：每个任务完成后把**源图 + 视频**推到指定聊天存档,纯出站、不打扰。
- **视频站归档(可选)**：生成完成后把 mp4 保存到你自己的网页,当前部署在 `https://yisal.eu.org/grok-videos/`。
- **高频设置优先**：提示词 A/B、保存按钮、时长、画质、比例、并发、模型放在设置页前面;Endpoint / API Key / Telegram 这类一次性配置放在底部折叠区,填好后自动隐藏。
- **提示词历史**：保存非空提示词时自动去重并置顶,不限制保存条数,可一键复用或删除。

## 🧱 架构

```
浏览器扩展 ──HTTPS──▶  api.5203333.xyz /v1/videos/generations ──▶ request_id
  (Alt+点击)              │
  抓图/抓帧               ▼
 新标签进度页 ◀──────  /v1/videos/{request_id} 轮询  ◀────────── done + video.url
```

旧代理模式仍可用:把 Endpoint 填成 `https://你的域名/i2v` 时,扩展会继续使用 `POST /i2v` 提交、`GET /status?id=` 轮询。

**两种接口模式**

1. **默认 API 模式**：Endpoint 填 `https://api.5203333.xyz` 或 `https://api.5203333.xyz/v1`,扩展会自动调用 `/v1/videos/generations` 和 `/v1/videos/{request_id}`。
2. **旧代理模式**：Endpoint 填 `https://你的域名/i2v`,继续走本仓库 `server/grok_i2v_server.py`,服务端集中放 xAI 凭证、代抓防盗链图片、处理 Telegram 推送。

## 📁 目录结构

```
.
├── manifest.json        # MV3 配置
├── background.js        # service worker:取图/重编码/letterbox、并发取号、开进度页、Telegram
├── content.js           # Alt+点击监听、媒体定位(穿透覆盖层)、canvas/视频帧抓取、截图兜底
├── content.css          # 原页面抓图时的进度遮罩样式
├── options.html / .js   # 设置页:提示词/生成参数优先,连接与推送配置折叠,历史不限条数
├── progress.html / .js  # 新标签进度页:排队→提交→轮询→播放结果;结果视频可续写
├── config.local.js      # 本地默认配置(endpoint/apiKey/secret),不入库(见 .gitignore)
├── icons/               # 16 / 48 / 128 图标
└── server/
    ├── grok_i2v_server.py       # 旧 /i2v 代理服务(标准库 + httpx)
    └── video_archive_server.js  # 轻量视频归档站(单文件 Node,无数据库)
```

## 🚀 部署

### 1. 默认:使用 `api.5203333.xyz`

扩展默认 Endpoint 为:

```text
https://api.5203333.xyz
```

设置页底部「连接与推送配置」里填写它认可的 API Key 后,点「测试连接」会请求 `/v1/models` 验证密钥。接口与密钥填好后,这块配置会默认折叠隐藏。实际生成时扩展会:

```text
POST https://api.5203333.xyz/v1/videos/generations
GET  https://api.5203333.xyz/v1/videos/{request_id}
```

本地默认值也可以写进 `config.local.js`:

```js
self.LOCAL_CONFIG = {
  endpoint: "https://api.5203333.xyz",
  apiKey: "填你的 API Key",
  model: "grok-imagine-video-1.5-preview",
  telegramBotToken: "可选:Telegram Bot Token",
  telegramChatId: "可选:Telegram Chat ID",
};
```

直连 `api.5203333.xyz` 时,Telegram 推送由扩展后台直接调用 Telegram Bot API 完成;留空 `telegramBotToken` 或 `telegramChatId` 就不推送。旧 `/i2v` 代理模式仍使用服务端环境变量 `TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_HOME_CHANNEL` / `TG_CHAT_ID` 推送。

### 2. 可选:视频站归档

当前 `ssh mx` 上已部署:

```text
URL:     https://yisal.eu.org/grok-videos/
Service: grok-video-archive.service
Code:    /opt/grok-video-archive/video_archive_server.js
Data:    /var/lib/grok-video-archive/
Config:  /etc/grok-video-archive/video-archive.env
```

扩展设置页底部填写:

```text
视频站归档地址: https://yisal.eu.org/grok-videos
视频站归档 Token: 与 VIDEO_ARCHIVE_TOKEN 一致
```

本地默认值也可写进 `config.local.js`:

```js
self.LOCAL_CONFIG = {
  archiveUrl: "https://yisal.eu.org/grok-videos",
  archiveToken: "填服务器 VIDEO_ARCHIVE_TOKEN",
};
```

归档服务只接收生成完成后的 `video_url`,由 `mx` 下载 mp4 并写入 `videos.json`;网页顶部输入一次归档 Token 后可删除视频,删除会同时移除索引记录和 mp4 文件。不需要在 Windows 本地运行任何服务。

### 3. 可选:旧 `/i2v` 代理服务

依赖:Python 3.9+ 与 `httpx`。

```bash
pip install httpx
export I2V_SECRET="$(openssl rand -hex 20)"   # 自定义一个强密钥
python3 server/grok_i2v_server.py             # 默认监听 127.0.0.1:8799
```

**xAI 凭证**(任选其一,优先级从上到下):

| 方式 | 说明 |
|---|---|
| **OAuth 账号池** | 把 xAI OAuth 账号 JSON 放进 `XAI_AUTH_DIR`(默认 `/opt/cliproxyapi/auths/`,文件名 `xai-*.json`)。服务自动选有额度的账号、跳过 403/禁用、token 过期自动刷新。 |
| `XAI_API_KEY` | 直接用 xAI API Key(在 [console.x.ai](https://console.x.ai) 获取)。 |

其它环境变量:

| 变量 | 说明 |
|---|---|
| `I2V_SECRET` | **必填**,Bearer 鉴权密钥,需与扩展设置页一致 |
| `I2V_HOST` / `I2V_PORT` | 监听地址,默认 `127.0.0.1` / `8799` |
| `XAI_AUTH_DIR` | OAuth 账号目录,默认 `/opt/cliproxyapi/auths` |
| `TELEGRAM_BOT_TOKEN` | 可选;留空则不推送 |
| `TELEGRAM_HOME_CHANNEL` / `TG_CHAT_ID` | 可选;推送目标 chat id |

**对外暴露(必须是 HTTPS**,否则 https 网页内的混合内容会被浏览器拦截**)**:用 Cloudflare Tunnel 或 nginx 反代到 `127.0.0.1:8799`。systemd 示例:

```ini
# /etc/systemd/system/grok-i2v.service
[Unit]
After=network-online.target
Wants=network-online.target
[Service]
Environment=I2V_SECRET=换成你的密钥
ExecStart=/usr/bin/python3 /path/to/server/grok_i2v_server.py
Restart=always
[Install]
WantedBy=multi-user.target
```

接口:`POST /i2v`(提交)、`GET /status?id=`(轮询)、`GET /health`(健康检查)。

默认模型为 `grok-imagine-video-1.5-preview`(可在请求里用 `model` 字段或扩展设置页覆盖为 `grok-imagine-video`)。

### 4. 浏览器扩展

1. 打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择本仓库根目录。
2. 点扩展图标打开设置页。页面前半部分是高频项:
   - **提示词 A / B**：左 Alt 用 A,右 Alt 用 B;「保存设置」按钮就在提示词 B 下方。
   - **时长 / 画质(480p / 720p)/ 比例 / 并发数 / 模型**：日常生成参数,直接显示。
   - **提示词历史**：保存非空提示词会自动加入历史,去重并把最近使用的放最前,不限制条数。
3. 展开底部「连接与推送配置」填写一次性配置:
   - **接口地址**：默认 `https://api.5203333.xyz`;也可填 `https://api.5203333.xyz/v1` 或旧代理 `https://你的域名/i2v`
   - **API Key**：使用 `api.5203333.xyz` 时填写它认可的 API Key;旧代理模式才填写服务端 `I2V_SECRET`
   - **Telegram Bot Token / Chat ID**：直连 API 模式需要在扩展设置页填写;旧代理模式可继续用服务端环境变量
   - **视频站归档地址 / Token**：留空则不归档;填好后生成完成会自动保存到视频站
   - 填好后该区域会默认折叠,只保留一行摘要;缺密钥时会自动展开提醒。
   - (也可把这些写进 `config.local.js` 作为本地默认值)
4. 点「测试连接」,应显示 API Key 有效或旧代理在线。
5. **本地图片/视频**：在扩展「详细信息」里开启「允许访问文件网址」。

## 🖱 使用

- **图片**：网页上 **按住 Alt + 左键点击** 任意图片 → 在弹出的提示词框里微调 → 点「生成视频」→ 新标签页显示进度 → 完成后播放。
- **视频关键帧**：**先把视频暂停**到想要的画面 → **Alt + 左键点击该视频** → 微调提示词后以当前帧为源图生成。结果页里同样可对生成的视频继续续写。
- **左/右 Alt**：左 Alt = 提示词 A,右 Alt = 提示词 B;弹窗里按 `Ctrl+Enter` 可直接确认生成,按 `Esc` 取消。

## ⚠️ 说明 / 限制

- **画质仅 480p / 720p**(xAI API 现状),填更高会被退回 720p。
- **比例只有 7 个受支持档**(1:1 / 16:9 / 9:16 / 4:3 / 3:4 / 3:2 / 2:3),无法精确等于任意原图比例;扩展用 letterbox(补黑边)保证画面不拉伸。
- **本地视频抓帧**:浏览器禁止读 `file://` 视频帧字节、canvas 会被污染,故走「隐藏播放控件 → 截当前可见画面 → 按视频区域裁剪」,画面不含播放控件。
- `grok-imagine-video-1.5-preview` 计费约为普通版的 2 倍,额度消耗更快。
- 图生视频为**付费**能力,按 xAI / 你的订阅计费。请遵守 xAI 及各站点的服务条款,仅作个人学习用途。

## 🔒 安全

- 密钥、token 等只存在于 `chrome.storage`、本地 `config.local.js` 或旧代理服务端环境变量 / 账号目录,不进仓库、不进网页。
- 扩展端的访问密钥保存在本地 `chrome.storage`。
- 代理对外部错误统一以 HTTP 200 + `{success:false}` 返回,避免 Cloudflare 用自己的错误页覆盖真实错误信息。
- 进度页用纯 DOM 构建(无内联脚本/事件),符合扩展页 CSP。

## License

[MIT](./LICENSE)
