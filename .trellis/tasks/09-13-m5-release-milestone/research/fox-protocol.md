# Fox（野狐）协议调研 — 2026-09-13

## 结论

Fox 同步**可移植**：维持版 lizzieyzy-next 的 `GetFoxRequest.java` 含未混淆端点，纯 HTTPS GET，无需登录即可拉取**公开**棋谱。历史版 yzyray/FoxRequest 端点刻意打码（"hide the link for avoiding fox official forbade the request"），新版未打码——以新版为准。

## 源与许可

- 来源：`wimi321/lizzieyzy-yzy` → 实际仓库 `wimi321/lizzieyzy-next`，`src/main/java/featurecat/lizzie/analysis/GetFoxRequest.java`（GPL-3.0，与本仓库同许可，移植合法且无需 relicense）。
- 配套样例脚本：同仓库 `scripts/fetch_fox_sgf_samples.py`（fixture 来源）。
- 私有谱路径 `TencentKifuDownload.java` 需登录，**M5 不做**。

## 端点（自 GetFoxRequest.java 源码摘录，实施时以实测为准）

| 用途 | 端点 | 参数 |
|---|---|---|
| 昵称 → uid | `GET https://newframe.foxwq.com/cgi/QueryUserInfoPanel?srcuid=0&username=<enc>` | username 需 UTF-8 后 **双重 URL-encode**（源码 `URLEncoder.encode(URLEncoder.encode(name,"UTF-8"),"UTF-8")`） |
| 分页拉谱 | `GET https://h5.foxwq.com/yehuDiamond/chessbook_local/YHWQFetchChess?uid=<enc>&lastcode=<enc>` | lastcode 为分页游标（首页空）；返回 JSON，SGF 在 payload 内 |
| 单局 | `GET .../YHWQFetchChess?chessid=<enc>` | |
| 失败回退 | `POST http://happyapp.huanle.qq.com/cgi-bin/CommonMobileCGI/TXWQFetchChess` → `http://cgi.foxwq.com/...` | form 编码，UA `okhttp/3.12.12`；**HTTP 非 HTTPS**——仅作回退链，主链全 HTTPS |

## 移植要点

- 用户 Agent：主链 `MOBILE_USER_AGENT`（源码常量，移植时照抄值）。
- 响应规范化：移植 `normalizeFoxSgfPayload`（SGF 可能在 JSON 字段中/base64/需转码，实施时录制真实响应逆向）。
- 分页游标语义：移植 `FoxKifuDownloadPaginationCursorTest` 的边界（该仓库有对应单测，可直接读其 fixture 语义）。
- 回退链顺序照抄（huanle.qq.com → cgi.foxwq.com），失败即向上抛——spec 要求故障隔离。

## 风险

- 端点无官方文档、随时可改/可封（spec 已标 "inherently fragile"）→ 录制 fixture 锁形状、限速 1req/2s、给用户可读错误。
- 回退链是明文 HTTP → 仅回退用；主链 HTTPS 覆盖正常使用。
