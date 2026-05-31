# Grok 图生视频 Chrome 扩展

> **Alt + 左键点击**网页上任意图片,调用 xAI **Grok Imagine**(`grok-imagine-video`)生成视频,并在**原图位置替换为视频**。配套一个轻量代理服务,负责集中放置凭证、绕过超时、处理防盗链图片,并可把成品推送到 Telegram 存档。

---

## ✨ 功能

- **Alt + 左键点图即生成**,完成后**原位替换**为自动播放、循环的视频;**双击视频还原原图**。
- **视频关键帧续写**:**暂停任意视频**后 Alt+左键点它,以**当前帧**为源图再生成一段——可对自己生成的视频不断「续写」。同源/跨域视频经 `blob:` 全质量抓帧;**本地视频**(`file://`,Chrome 禁止读取其帧字节、canvas 必污染)则**隐藏原生播放控件后截当前可见画面再裁剪**——画面干净,不含播放键/进度条。
- **任意图片来源**:普通网页图、跨域防盗链图(如各类 booru 站)、本地 `file://` 图片都支持。
- **穿透覆盖层 · 选当前图**:对图片上盖了透明层/占位层的站点(如**抖音图文多图**),Alt+点击会自动选出**当前正在看的那张真图**——按「覆盖点击点 · 非占位(跳过 noop 等)· 最不透明 · 面积最大」挑选;多图轮播切到哪张就抓哪张。带 CORS 的跨域 CDN(如 douyinpic)由浏览器端 `fetch→重画` 抓取。
- **可配置**:画质、时长、画面比例、提示词;**提示词历史**可保存与一键复用。
- **并发 + 排队**:一次点多张,按设定并发数(默认 3)逐批处理,其余自动排队;遇 API 限流自动退避重试。
- **Telegram 推送(可选)**:每个任务完成后把**源图 + 视频**推到指定 Telegram 聊天存档,纯出站、不打扰。
- 图片自动**重编码为 JPEG**(最长边 ≤1280px、铺白底),规避 WebP / 透明通道 / 超大尺寸被 API 拒绝。

## 🧱 架构

```
浏览器扩展 ──HTTPS──▶  代理服务 /i2v  ──▶  xAI grok-imagine-video  ──▶ 视频 URL
  (Alt+点图)            鉴权/取图/                (异步:提交→轮询)          │
                        轮询/推Telegram                                      ▼
  原位替换  ◀──────────  /status 轮询  ◀────────────────────────  done + video.url
```

**为什么要一个代理,而不是扩展直连 xAI?**

1. **集中放凭证 / 绕过 CORS**:xAI 凭证只在服务端,不进浏览器。
2. **绕过 Cloudflare 100s 超时**:视频生成常需 1–3 分钟。代理改成「提交即返回 `request_id`,前端轮询 `/status`」,每个 HTTP 请求都很短。
3. **凭证灵活**:服务端可用 `XAI_API_KEY`,**也可复用 [hermes-agent](https://github.com/NousResearch/hermes-agent) 的 xAI OAuth 登录**(按 SuperGrok / Premium+ 订阅计费,token 自动刷新)。
4. **服务端代抓防盗链图**(带 Referer / 浏览器 UA)、统一图片格式、并负责 Telegram 推送。

## 📁 目录结构

```
.
├── manifest.json        # MV3 配置
├── background.js        # service worker:取图/重编码、并发取号、提交+轮询、429 重试
├── content.js           # Alt+点击监听、canvas 取本地/同源图、进度遮罩、原位替换、排队
├── content.css          # 遮罩 / spinner / 错误提示样式
├── options.html / .js   # 设置页(endpoint / secret / 时长 / 画质 / 比例 / 并发 / 提示词+历史)
├── icons/               # 16 / 48 / 128 图标
└── server/
    └── grok_i2v_server.py   # 代理服务(标准库 + httpx,零框架)
```

## 🚀 部署

### 1. 代理服务

依赖:Python 3.9+ 与 `httpx`。

```bash
pip install httpx
export I2V_SECRET="$(openssl rand -hex 20)"   # 自定义一个强密钥
export XAI_API_KEY="xai-..."                  # 方式 A:直接用 xAI API Key
# 方式 B:在已安装 hermes-agent 且登录了 xai-oauth 的机器上运行,
#         服务会自动复用其订阅凭证,无需 XAI_API_KEY。
python3 server/grok_i2v_server.py             # 默认监听 127.0.0.1:8799
```

环境变量:

| 变量 | 说明 |
|---|---|
| `I2V_SECRET` | **必填**,Bearer 鉴权密钥,需与扩展设置页一致 |
| `XAI_API_KEY` | xAI API Key(若不复用 hermes OAuth) |
| `I2V_HOST` / `I2V_PORT` | 监听地址,默认 `127.0.0.1` / `8799` |
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
Environment=XAI_API_KEY=xai-...
ExecStart=/usr/bin/python3 /path/to/server/grok_i2v_server.py
Restart=always
[Install]
WantedBy=multi-user.target
```

接口:`POST /i2v`(提交)、`GET /status?id=`(轮询)、`GET /health`(健康检查)。

### 2. 浏览器扩展

1. 打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择本仓库根目录。
2. 点扩展图标打开设置页,填写:
   - **代理地址**:`https://你的域名/i2v`
   - **访问密钥**:与服务端 `I2V_SECRET` 一致
   - 时长 / 画质(480p / 720p)/ 比例 / 并发数 / 提示词
3. 点「测试连接」,应显示「代理在线,凭证有效」。

## 🖱 使用

- **图片**:网页上 **按住 Alt + 左键点击** 任意图片 → 等待(约 1–3 分钟)→ 原位变视频。双击视频可还原原图。
- **视频关键帧**:**先把视频暂停**到想要的画面 → **Alt + 左键点击该视频** → 以当前帧为源图再生成。可对生成结果反复续写。本地视频走"隐藏控件→截画面→裁剪",无需选文件、画面不含播放控件。

## ⚠️ 说明 / 限制

- **画质仅 480p / 720p**(xAI API 现状),填更高会被退回 720p。
- **本地 `file://` 图片**:由内容脚本用 canvas 直接读取;若读不到,需在扩展「详细信息」里开启「允许访问文件网址」。
- **MV3 特性**:生成是后台异步,关掉标签页不影响 Telegram 推送;但页面端的「原位替换」依赖标签页存活。
- 图生视频为**付费**能力,按 xAI / 你的订阅计费。请遵守 xAI 及各站点的服务条款,仅作个人学习用途。

## 🔒 安全

- 密钥、token 等只存在于**服务端环境变量**,不进仓库、不进浏览器页面。
- 扩展端的访问密钥保存在本地 `chrome.storage`。
- 代理对外部错误统一以 HTTP 200 + `{success:false}` 返回,避免 Cloudflare 用自己的错误页覆盖真实错误信息。

## License

[MIT](./LICENSE)
