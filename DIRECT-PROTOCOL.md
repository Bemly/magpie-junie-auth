# Junie Lite 直连协议（逆向实测，2026-11-25）

**结论：不需要 CLI 本体，纯 HTTP 直连即可用免费额度出字。** 延迟约 3-4 秒（对比 CLI 桥接的 30-36 秒）。

之前直连全部失败是因为请求头组合不对。协议是从 CLI v4171.6 的真实请求中抓出来的（JVM `-Djavax.net.debug=ssl:plaintext` 会打印 TLS 内 HTTP 明文）。

## 端点

```
POST https://ingrazzio-cloud-prod.labs.jb.gg/v1/responses
```

## 必需请求头（缺一不可）

| Header | 值 | 备注 |
|---|---|---|
| `Authorization` | `Bearer <id_token>` | 用 id_token，不是 access_token；从 OAuth refresh 或 keychain 取 |
| `Accept` | `text/event-stream,text/event-stream` | 非流式也这么发 |
| `X-LLM-Model` | `openai` | **关键**，之前猜 jbai 全错 |
| `X-Keep-Path` | `true` | |
| `X-Forced-License-Free` | `2` | **关键**，不是 `true`（新版值） |
| `X-Accept-EAP-License` | `false` | **关键**，之前传 true 导致失败 |
| `X-Accept-Release-License` | `false` | 同上 |
| `Grazie-Agent` | `{"name":"junie:cli","version":"4171.6:4171.6"}` | 版本格式是 `V:V` |
| `X-Client-Feature-Id` | `junie` | 不是 `junie-cli/版本` |
| `X-Client-Execution-Id` | 任意字符串 | |
| `Accept-Encoding` | `identity` | |
| `JetBrains-LLM-Context` | `purpose=LANGUAGE_DETECTION` 或 `purpose=ISSUE_AGENT` | CLI 按用途区分 |
| `Openai-Version` | `2020-11-07` | |
| `User-Agent` | `junie-cli-batch:26.11.3` | marketing 版本 |
| `Cache-Control` | `no-store` | |
| `Content-Type` | `application/json` | |

## Body（Responses API 格式，不是 chat completions）

```json
{
  "model": "gpt-6-luna",
  "input": [{"role": "user", "content": "只回复OK"}],
  "stream": false,
  "text": {"format": {"type": "text"}},
  "reasoning": {"effort": "low"},
  "store": false,
  "prompt_cache_retention": "24h"
}
```

- `model` 必须是 wireName `gpt-6-luna`（不是 `junie-lite`、不是 `openai-gpt-6-luna`）
- `input` 是 Responses API 格式；CLI 里元素用 `{"type":"input_text","text":...}`，简单字符串也可工作
- `stream: true` 返回标准 SSE（`response.created` / `response.output_text.delta` / ...）

## 响应

非流式 HTTP 200 JSON：`output[].content[]` 中 `type=output_text` 的 `text` 即回复；`status`、`usage` 正常。
流式 SSE 逐字 `delta`，结构同 OpenAI Responses API。

## 验证记录

- 2026-11-25 00:43 HKT：非流式 `HTTP 200 / 3.77s`，回复 "OK"，usage 14 tokens
- 同日：流式 SSE 正常输出 "流式"

## Token 获取

`POST https://oauth.account.jetbrains.com/oauth2/token`，`grant_type=refresh_token`，
`client_id=junie-cli`，`refresh_token=<keychain 里的 refresh>`；取 `id_token`。
macOS keychain 读取见 `lib/credentials.mjs` 的 `readMacKeychainCredentials()`。

## 待做

把这套协议写进插件的 `lib/fetch.mjs`（替换现有直连逻辑），让 `junie` provider 不配 `bridgeUrl` 也能用免费额度，从而去掉 CLI 本体依赖。
