// 直连 Responses API（逆向 CLI v4171.6 实测，2026-11-25）。
// 不需要 CLI 本体，纯 HTTP 直连即可用免费额度（gpt-6-luna）。
// 精确请求头/body 见 DIRECT-PROTOCOL.md。
//
// magpie 侧发来的是 OpenAI Chat Completions（npm: @ai-sdk/openai-compatible），
// 这里把它转成 Responses API：/v1/responses + input[] + model=gpt-6-luna，
// 再把响应转回 chat completions（非流式 JSON / 流式 SSE）。

import { proxyFetch } from "./proxy.mjs"

export const DIRECT_URL = "https://ingrazzio-cloud-prod.labs.jb.gg/v1/responses"
export const DIRECT_MODEL = "gpt-6-luna"

/** CLI 抓包得到的精确请求头；token 与 execution id 每次调用注入。 */
export function directHeaders(token, { effort = "low", purpose = "ISSUE_AGENT", agentVersion = "4171.6:4171.6" } = {}) {
  return {
    "Authorization": `Bearer ${token}`,
    "Accept": "text/event-stream,text/event-stream",
    "X-LLM-Model": "openai",
    "X-Keep-Path": "true",
    "X-Forced-License-Free": "2",
    "X-Accept-EAP-License": "false",
    "X-Accept-Release-License": "false",
    "Grazie-Agent": `{"name":"junie:cli","version":"${agentVersion}"}`,
    "X-Client-Feature-Id": "junie",
    "X-Client-Execution-Id": `junie-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    "Accept-Encoding": "identity",
    "JetBrains-LLM-Context": `purpose=${purpose}`,
    "Openai-Version": "2020-11-07",
    "User-Agent": "junie-cli-batch:26.11.3",
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
  }
}

/** Chat Completions messages → Responses input[]（system 提为 instructions）。 */
export function toResponsesInput(messages = []) {
  const input = []
  let instructions
  for (const m of messages) {
    const role = m?.role ?? "user"
    let text = m?.content ?? ""
    if (Array.isArray(text)) text = text.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("\n")
    if (role === "system") {
      instructions = instructions ? instructions + "\n" + text : text
      continue
    }
    input.push({ role, content: String(text) })
  }
  return { input, instructions }
}

/** 构造 Responses 请求 body。 */
export function toResponsesBody(chat, { model = DIRECT_MODEL, effort } = {}) {
  const { input, instructions } = toResponsesInput(chat?.messages)
  const eff = effort ?? chat?.reasoning_effort ?? chat?.reasoning?.effort ?? "low"
  const body = {
    model,
    input,
    stream: Boolean(chat?.stream),
    text: { format: { type: "text" } },
    store: false,
  }
  if (instructions) body.instructions = instructions
  if (eff && eff !== "none") body.reasoning = { effort: eff }
  if (chat?.max_tokens || chat?.max_completion_tokens) body.max_output_tokens = chat.max_tokens ?? chat.max_completion_tokens
  return body
}

/** Responses JSON → Chat Completions JSON。 */
export function fromResponsesJSON(resp, model = "junie-lite") {
  let text = ""
  const outputs = resp?.output ?? []
  for (const item of outputs) {
    if (item?.type !== "message") continue
    for (const c of item?.content ?? []) {
      if (c?.type === "output_text" && typeof c.text === "string") text += c.text
    }
  }
  const u = resp?.usage ?? {}
  return {
    id: resp?.id ?? `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: resp?.created_at ?? Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: u.input_tokens ?? 0,
      completion_tokens: u.output_tokens ?? 0,
      total_tokens: u.total_tokens ?? 0,
    },
  }
}

/** 把 Responses SSE 流转成 Chat Completions SSE 流。 */
export function responsesSSEToChatSSE(bytes, model = "junie-lite") {
  const dec = new TextDecoder()
  const events = dec.decode(bytes).split(/\r?\n\r?\n/)
  const out = []
  const id = `chatcmpl-${Date.now()}`
  for (const ev of events) {
    const line = ev.split(/\r?\n/).find((l) => l.startsWith("data:"))
    if (!line) continue
    let d
    try { d = JSON.parse(line.slice(5).trim()) } catch { continue }
    const t = d?.type
    if (t === "response.output_text.delta") {
      const delta = d.delta ?? ""
      out.push(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] })}\n\n`)
    } else if (t === "response.completed") {
      out.push(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`)
      out.push("data: [DONE]\n\n")
    }
  }
  if (!out.some((s) => s.includes("[DONE]"))) out.push("data: [DONE]\n\n")
  return new TextEncoder().encode(out.join(""))
}

/**
 * 直连 fetch：magpie 调它，返回标准 chat completions 响应。
 * @param auth 已登录账号（access=id_token）
 * @param options 插件选项（model / effort / grazieAgentVersion / proxy）
 */
export function makeDirectFetch(auth, options = {}) {
  const token = auth?.access ?? auth?.key

  return async function directFetch(input, init = {}) {
    const url = new URL(String(input))
    // magpie 可能发 /chat/completions、/responses 或模型名路径；统一到 /v1/responses
    url.pathname = "/v1/responses"
    url.search = ""

    const chat = (() => {
      try {
        const b = init.body
        return typeof b === "string" ? JSON.parse(b) : JSON.parse(new TextDecoder().decode(b))
      } catch { return {} }
    })()

    const hdrs = directHeaders(token, {
      purpose: options.purpose ?? "ISSUE_AGENT",
      agentVersion: options.grazieAgentVersion,
    })
    const body = JSON.stringify(toResponsesBody(chat, {
      model: options.model ?? DIRECT_MODEL,
      effort: options.effort,
    }))
    const stream = Boolean(chat.stream)

    const res = await proxyFetch(url.toString(), {
      method: "POST",
      headers: hdrs,
      body,
      signal: init.signal,
    }, { proxy: options.proxy })

    if (!res.ok) {
      const text = await res.text()
      return new Response(text, { status: res.status, statusText: res.statusText, headers: { "Content-Type": "application/json" } })
    }

    const replyModel = chat.model ?? "junie-lite"
    if (stream) {
      const bytes = new Uint8Array(await res.arrayBuffer())
      return new Response(responsesSSEToChatSSE(bytes, replyModel), {
        status: 200,
        headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
      })
    }
    const resp = await res.json()
    return new Response(JSON.stringify(fromResponsesJSON(resp, replyModel)), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    })
  }
}

export const _internal = {
  directHeaders, toResponsesInput, toResponsesBody,
  fromResponsesJSON, responsesSSEToChatSSE, makeDirectFetch,
}
