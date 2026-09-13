# Fox fixtures 来源声明

本目录的 `*.json` fixture 是**结构性模拟**：按 research/fox-protocol.md 记录的端点形状手工构造（昵称查询、分页列表、单局 SGF 载荷），字段名与嵌套层级照抄 lizzieyzy-next `GetFoxRequest.java` 的解析预期，uid/昵称/棋谱内容均为脱敏或虚构。

** live 验证状态：未做。** 实施当日网络无法稳定到达 foxwq.com（与 OpenCL 资产同期网络受限）。协议层对 fixture 全绿仅证明"解析形状正确"，不证明"线上形状未变"——这正是 spec 把 integrations 标记为 inherently fragile 的原因。首次真实联调时：用 `scripts/fetch_fox_sgf_samples.py`（lizzieyzy-next 自带）抓真实响应，若字段形状不符，改 protocol.ts 的 normalize 函数并同步更新 fixture，live 样本留存于此目录（`*.live.json` 后缀）。
