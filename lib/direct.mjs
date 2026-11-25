// 直连 Responses API（逆向 CLI v4171.6 实测，2026-11-25）。
// 不需要 CLI 本体，纯 HTTP 直连即可用免费额度（gpt-6-luna）。
// 精确请求头/body 见 DIRECT-PROTOCOL.md。
//
// magpie 侧发来的是 OpenAI Chat Completions（agent 常用 tools / 图片 / 流式），
// 这里做双向协议转换：
//   chat.completions  → /v1/responses（input[] + tools + tool_choice）
//   responses 返回    → chat.completions（含 tool_calls / 真流式 SSE / usage）
//
// 关键映射（OpenAI Responses 规范，CLI 抓包确认事件名）：
//   chat tools[{type:function,function:{name,description,parameters}}]
//     → responses tools[{type:function,name,description,parameters}]
//   assistant.tool_calls[{id,function:{name,arguments}}]
//     → input item {type:function_call,call_id,name,arguments}
//   role:"tool" {tool_call_id,content}
//     → input item {type:function_call_output,call_id,output}
//   output item {type:function_call,...}
//     → chat tool_calls[{id,type:function,function:{name,arguments}}]
//   SSE response.function_call_arguments.delta/.done
//     → chat delta.tool_calls[].function.arguments

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

/** chat content(字符串或 parts) → 纯文本（system/instructions 用）。 */
function contentToText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return content == null ? "" : String(content)
  return content.map((p) => {
    if (typeof p === "string") return p
    if (p?.type === "text") return p.text ?? ""
    if (p?.type === "input_text") return p.text ?? ""
    return ""
  }).join("\n")
}

/**
 * chat content parts → Responses input content parts。
 * 保留 text / image_url / input_image；未识别的 part 保留其 text 字段而不静默丢弃。
 */
function contentToParts(content) {
  if (content == null) return undefined
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return String(content)
  const parts = []
  for (const p of content) {
    if (typeof p === "string") { parts.push({ type: "input_text", text: p }); continue }
    if (!p || typeof p !== "object") continue
    if (p.type === "text" || p.type === "input_text") {
      parts.push({ type: "input_text", text: String(p.text ?? "") })
    } else if (p.type === "image_url" || p.type === "input_image") {
      const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url
      const detail = typeof p.image_url === "object" ? p.image_url.detail : p.detail
      const out = { type: "input_image" }
      if (url) out.image_url = url
      if (detail) out.detail = detail
      parts.push(out)
    } else if (p.type === "input_file" || p.type === "file") {
      parts.push({ type: "input_file", ...(p.file_id ? { file_id: p.file_id } : {}), ...(p.filename ? { filename: p.filename } : {}) })
    } else if (p.text != null) {
      // 不静默丢内容：未知 part 有 text 就按文本发
      parts.push({ type: "input_text", text: String(p.text) })
    }
  }
  return parts.length ? parts : ""
}

/**
 * Chat Completions messages → Responses input[]（system 提为 instructions）。
 * assistant.tool_calls → function_call item；role:"tool" → function_call_output item。
 */
export function toResponsesInput(messages = []) {
  const input = []
  let instructions
  for (const m of messages) {
    if (!m || typeof m !== "object") continue
    const role = m.role ?? "user"
    if (role === "system") {
      // 纯文本 system → instructions；含图片等非文本 part 时 instructions 放不下，
      // 保留为 input 里的 system message，避免静默丢内容。
      const hasNonText = Array.isArray(m.content) && m.content.some((p) =>
        p && typeof p === "object" && (p.type === "image_url" || p.type === "input_image" || p.type === "file" || p.type === "input_file"))
      if (!hasNonText) {
        const text = contentToText(m.content)
        instructions = instructions ? instructions + "\n" + text : text
        continue
      }
      input.push({ role: "system", content: contentToParts(m.content) })
      continue
    }
    if (role === "tool") {
      // Responses 没有 tool role；function_call_output 用 call_id 关联。
      input.push({
        type: "function_call_output",
        call_id: m.tool_call_id ?? m.id ?? "",
        output: contentToParts(m.content) ?? "",
      })
      continue
    }
    if (role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      // 文本部分（可能为空）仍作为 assistant message 发出，避免历史断裂
      const text = contentToText(m.content)
      if (text) input.push({ role: "assistant", content: text })
      for (const tc of m.tool_calls) {
        // Responses 规范：arguments 必须是 JSON 字符串；AI SDK 有时给对象。
        let args = tc.function?.arguments ?? tc.arguments ?? "{}"
        if (args != null && typeof args !== "string") {
          try { args = JSON.stringify(args) } catch { args = String(args) }
        }
        input.push({
          type: "function_call",
          call_id: tc.id ?? tc.call_id ?? "",
          name: tc.function?.name ?? tc.name ?? "",
          arguments: args || "{}",
        })
      }
      continue
    }
    const parts = contentToParts(m.content)
    input.push({ role, content: parts === undefined ? "" : parts })
  }
  return { input, instructions }
}

/** chat tools / tool_choice → Responses 形状。 */
export function toResponsesTools(chat = {}) {
  const out = {}
  if (Array.isArray(chat.tools) && chat.tools.length) {
    out.tools = chat.tools.map((t) => {
      if (t?.type === "function" && t.function) {
        return {
          type: "function",
          name: t.function.name ?? t.name,
          ...(t.function.description != null ? { description: t.function.description } : {}),
          parameters: t.function.parameters ?? {},
        }
      }
      return t
    })
  }
  if (chat.tool_choice != null) {
    const c = chat.tool_choice
    if (typeof c === "string") out.tool_choice = c
    else if (c?.type === "function") {
      out.tool_choice = { type: "function", name: c.function?.name ?? c.name }
    } else out.tool_choice = c
  }
  return out
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
    ...toResponsesTools(chat),
  }
  if (instructions) body.instructions = instructions
  if (eff && eff !== "none") body.reasoning = { effort: eff }
  if (chat?.max_tokens || chat?.max_completion_tokens) body.max_output_tokens = chat.max_tokens ?? chat.max_completion_tokens
  // 生成控制字段：真机验证 gpt-6-luna 只接受 parallel_tool_calls；
  // temperature / top_p / stop_sequences 会被上游 400（unsupported/unknown parameter），
  // 所以这里主动丢弃，避免 agent 传它们时整请求失败。
  if (chat?.parallel_tool_calls != null) body.parallel_tool_calls = Boolean(chat.parallel_tool_calls)
  // n>1：Responses 无多候选概念，降级为单候选（返回 1 个 choice），不转发 n。
  // response_format: chat 的 json_object / json_schema → Responses 的 text.format
  const rf = chat?.response_format
  if (rf && typeof rf === "object") {
    if (rf.type === "json_object") body.text = { format: { type: "json_object" } }
    else if (rf.type === "json_schema" && rf.json_schema) {
      body.text = { format: { type: "json_schema", name: rf.json_schema.name ?? "schema", schema: rf.json_schema.schema ?? rf.json_schema } }
    }
  }
  return body
}

/** Responses output items → chat message（text + tool_calls）+ finish_reason。 */
function responseItemsToMessage(items = []) {
  let text = ""
  let reasoningText = ""
  const toolCalls = []
  for (const item of items) {
    if (item?.type === "message") {
      for (const c of item?.content ?? []) {
        if ((c?.type === "output_text" || c?.type === "input_text") && typeof c.text === "string") text += c.text
        else if (c?.type === "refusal" && typeof c.refusal === "string") text += `[refusal: ${c.refusal}]`
        else if (c?.type === "output_image" && c.image_url) text += `[image: ${c.image_url}]`
        else if (c?.text) text += String(c.text)
      }
    } else if (item?.type === "function_call") {
      toolCalls.push({
        id: item.call_id ?? item.id ?? `call_${Math.random().toString(36).slice(2)}`,
        type: "function",
        function: { name: item.name ?? "", arguments: item.arguments ?? "{}" },
      })
    } else if (item?.type === "reasoning") {
      // reasoning 不进 content，但兼容客户端通过 reasoning_content 读摘要。
      const summary = (item.summary ?? []).map((s) => s?.text ?? "").filter(Boolean).join("\n")
      if (summary) reasoningText += summary
    }
  }
  const message = { role: "assistant", content: text }
  if (reasoningText) message.reasoning_content = reasoningText
  if (toolCalls.length) message.tool_calls = toolCalls
  return { message, finish_reason: toolCalls.length ? "tool_calls" : "stop" }
}

/** Responses JSON → Chat Completions JSON。 */
/** Responses status/status_details → Chat finish_reason。 */
export function finishReasonOf(resp, defaultReason = "stop") {
  if (resp?.status === "incomplete") {
    const reason = resp?.status_details?.reason ?? resp?.status_details?.type
    return reason === "max_output_tokens" || reason === "length" ? "length" : "content_filter"
  }
  if (resp?.status === "failed" || resp?.status === "cancelled") return "stop"
  return defaultReason
}

export function fromResponsesJSON(resp, model = "junie-lite") {
  const { message, finish_reason: itemReason } = responseItemsToMessage(resp?.output)
  const finish_reason = finishReasonOf(resp, itemReason)
  // HTTP 200 但 upstream 报错/失败时，把原因作为内容返回，别让 agent 当成空成功。
  const failure = resp?.error ?? (resp?.status === "failed" ? (resp?.status_details ?? "upstream failed") : null)
  if (failure) {
    const msg = typeof failure === "string" ? failure : (failure?.message ?? failure?.type ?? "upstream error")
    message.content = message.content || `[Junie upstream error: ${String(msg).slice(0, 500)}]`
  }
  const u = resp?.usage ?? {}
  return {
    id: resp?.id ?? `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: resp?.created_at ?? Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason }],
    usage: {
      prompt_tokens: u.input_tokens ?? 0,
      completion_tokens: u.output_tokens ?? 0,
      total_tokens: u.total_tokens ?? 0,
    },
  }
}

/**
 * Responses SSE 事件 → Chat Completions SSE chunk（可逐个事件调用）。
 * 返回字符串数组（可能为空）；工具调用按 index 递增。
 */
export function responseEventToChatChunks(d, model, id, state) {
  const created = Math.floor(Date.now() / 1000)
  const chunk = (delta, finish_reason = null, usage) => {
    const o = {
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta, finish_reason }],
    }
    if (usage) o.usage = usage
    return `data: ${JSON.stringify(o)}\n\n`
  }
  const out = []
  const t = d?.type
  if (t === "response.output_text.delta") {
    if (d.delta) {
      state.textDelta = (state.textDelta ?? "") + d.delta
      out.push(chunk({ content: d.delta }))
    }
  } else if (t === "response.output_text.done") {
    // 兜底：delta 缺失/截断时用完整 text 补齐差额（与 function_call_arguments.done 对称）。
    const full = d.text ?? ""
    const got = state.textDelta ?? ""
    if (full && full !== got) {
      out.push(chunk({ content: full.slice(got.length) }))
      state.textDelta = full
    }
  } else if (t === "response.output_item.added" && d.item?.type === "function_call") {
    const idx = state.toolIndex++
    state.toolById.set(d.item.id ?? d.item.call_id, idx)
    out.push(chunk({
      tool_calls: [{
        index: idx,
        id: d.item.call_id ?? d.item.id,
        type: "function",
        function: { name: d.item.name ?? "", arguments: "" },
      }],
    }))
  } else if (t === "response.function_call_arguments.delta") {
    // 有些上游不发 output_item.added；delta 本身也说明有工具调用，
    // 补一个占位首帧让客户端拿到 index（name/id 未知时留空）。
    if (!state.toolById.has(d.item_id)) {
      const idx = state.toolIndex++
      state.toolById.set(d.item_id, idx)
      out.push(chunk({ tool_calls: [{ index: idx, type: "function", function: { name: "", arguments: "" } }] }))
    }
    const idx = state.toolById.get(d.item_id)
    if (d.delta) {
      state.argByTool ??= new Map()
      state.argByTool.set(idx, (state.argByTool.get(idx) ?? "") + d.delta)
      out.push(chunk({ tool_calls: [{ index: idx, function: { arguments: d.delta } }] }))
    }
  } else if (t === "response.function_call_arguments.done") {
    // 兜底：若 delta 缺失/被截断，用 done 的完整 arguments 补齐。
    const idx = state.toolById.get(d.item_id) ?? 0
    const full = d.arguments ?? ""
    const got = state.argByTool?.get(idx) ?? ""
    if (full && full !== got) {
      out.push(chunk({ tool_calls: [{ index: idx, function: { arguments: full.slice(got.length) } }] }))
      if (state.argByTool) state.argByTool.set(idx, full)
    }
  } else if (t === "response.failed" || t === "response.error") {
    // 上游失败/拒绝：把原因作为文本吐出，别让 agent 收到空 successful 回复。
    const err = d.response?.error ?? d.error ?? d
    const msg = typeof err === "string" ? err : (err?.message ?? err?.type ?? "upstream error")
    out.push(chunk({ content: `[Junie upstream ${t}: ${String(msg).slice(0, 500)}]` }))
    out.push(chunk({}, "stop"))
    out.push("data: [DONE]\n\n")
    state.done = true
  } else if (t === "response.completed" || t === "response.incomplete") {
    const u = d.response?.usage ?? {}
    const usage = u.input_tokens != null || u.output_tokens != null
      ? { prompt_tokens: u.input_tokens ?? 0, completion_tokens: u.output_tokens ?? 0, total_tokens: u.total_tokens ?? 0 }
      : undefined
    const reason = t === "response.incomplete"
      ? finishReasonOf({ ...d.response, status: "incomplete" }, "stop")
      : (state.toolIndex ? "tool_calls" : "stop")
    out.push(chunk({}, reason, usage))
    out.push("data: [DONE]\n\n")
    state.done = true
  }
  return out
}

/** 一次性把 Responses SSE 字节流转成 Chat SSE（测试/非浏览器用）。 */
export function responsesSSEToChatSSE(bytes, model = "junie-lite") {
  const state = { toolIndex: 0, toolById: new Map(), done: false }
  const id = `chatcmpl-${Date.now()}`
  let buf = new TextDecoder().decode(bytes)
  const out = []
  let frame
  while ((frame = nextSSEFrame(buf))) {
    const raw = buf.slice(0, frame.index)
    buf = buf.slice(frame.index + frame.sepLen)
    const d = parseSSEFrame(raw)
    if (d) out.push(...responseEventToChatChunks(d, model, id, state))
  }
  if (buf.trim()) {
    const d = parseSSEFrame(buf)
    if (d) out.push(...responseEventToChatChunks(d, model, id, state))
  }
  if (!state.done) out.push(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`, "data: [DONE]\n\n")
  return new TextEncoder().encode(out.join(""))
}

/**
 * 从 SSE 缓冲里取出下一个完整帧的边界，返回 {index, sepLen} 或 null。
 * 同时兼容 \n\n 与 \r\n\r\n，并取位置更靠前的那个——
 * 若总是优先找 CRLF，混用分隔符时会跳过先到的 LF 帧导致文本丢失。
 */
export function nextSSEFrame(buf) {
  const a = buf.indexOf("\n\n")
  const b = buf.indexOf("\r\n\r\n")
  if (a < 0 && b < 0) return null
  if (b >= 0 && (a < 0 || b < a)) return { index: b, sepLen: 4 }
  return { index: a, sepLen: 2 }
}

/** 解析一帧 SSE 的 data 载荷；不是 data 行或无有效 JSON 返回 null。 */
export function parseSSEFrame(raw) {
  const line = raw.split(/\r?\n/).find((l) => l.startsWith("data:"))
  if (!line) return null
  const data = line.slice(5).trim()
  if (!data || data === "[DONE]") return null
  try { return JSON.parse(data) } catch { return null }
}

/**
 * 直连 fetch：magpie 调它，返回标准 chat completions 响应。
 * 流式用 ReadableStream 边读边转，长回答期间客户端持续收到 chunk。
 */
export function makeDirectFetch(auth, options = {}) {
  const token = auth?.access ?? auth?.key

  return async function directFetch(input, init = {}) {
    if (!token) {
      return new Response(JSON.stringify({
        error: { message: "Junie 未登录：缺少 access token", type: "auth_error" },
      }), { status: 401, headers: { "Content-Type": "application/json" } })
    }
    const url = new URL(String(input))
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
      // 透传退避相关头（retry-after / x-ratelimit-*），agent 的限流处理依赖它们。
      const h = { "Content-Type": "application/json" }
      for (const k of ["retry-after", "x-ratelimit-limit-requests", "x-ratelimit-remaining-requests", "x-ratelimit-reset-requests", "x-ratelimit-limit-tokens", "x-ratelimit-remaining-tokens", "x-ratelimit-reset-tokens"]) {
        const v = res.headers?.get?.(k)
        if (v) h[k] = v
      }
      return new Response(text, { status: res.status, statusText: res.statusText, headers: h })
    }

    const replyModel = chat.model ?? "junie-lite"
    if (stream && res.body) {
      const reader = res.body.getReader()
      const state = { toolIndex: 0, toolById: new Map(), done: false }
      const id = `chatcmpl-${Date.now()}`
      const enc = new TextEncoder()
      const readable = new ReadableStream({
        start(controller) {
          // 后台循环持续读上游、解析 SSE、立即 enqueue。
          // 不用 pull：上游会有空/心跳 chunk，pull 不 enqueue 会暂停流导致挂死。
          ;(async () => {
            let buf = ""
            const dec = new TextDecoder()
            try {
              const emit = (d) => {
                if (!d) return
                for (const s of responseEventToChatChunks(d, replyModel, id, state)) controller.enqueue(enc.encode(s))
              }
              for (;;) {
                const { value, done } = await reader.read()
                if (done) break
                buf += dec.decode(value, { stream: true })
                let frame
                while ((frame = nextSSEFrame(buf))) {
                  const raw = buf.slice(0, frame.index)
                  buf = buf.slice(frame.index + frame.sepLen)
                  emit(parseSSEFrame(raw))
                }
              }
              // 流结束时处理残留：最后一个 SSE 帧可能不带结尾空行；
              // 也可能上游根本没发 SSE 而直接给了 JSON（错误/降级），别静默吞掉。
              const tail = buf.trim() + dec.decode()
              if (tail) {
                const d = parseSSEFrame(tail)
                if (d) emit(d)
                else if (tail.startsWith("{")) {
                  try {
                    const raw = JSON.parse(tail)
                    const c = fromResponsesJSON(raw, replyModel)
                    const msg = c.choices?.[0]?.message
                    if (msg?.content) controller.enqueue(enc.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: replyModel, choices: [{ index: 0, delta: { content: msg.content }, finish_reason: null }] })}\n\n`))
                    if (msg?.tool_calls?.length) controller.enqueue(enc.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: replyModel, choices: [{ index: 0, delta: { tool_calls: msg.tool_calls.map((tc, i) => ({ index: i, ...tc })) }, finish_reason: null }] })}\n\n`))
                    // 不设 state.done：下面的兜底还要发 finish + [DONE]
                  } catch { /* 非 JSON 残留忽略 */ }
                }
              }
            } catch (e) {
              try { controller.error(e) } catch {}
              return
            }
            if (!state.done) {
              controller.enqueue(enc.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: replyModel, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`))
              controller.enqueue(enc.encode("data: [DONE]\n\n"))
            }
            controller.close()
          })()
        },
        cancel() { try { reader.cancel() } catch {} },
      })
      return new Response(readable, {
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
  directHeaders, toResponsesInput, toResponsesTools, toResponsesBody,
  fromResponsesJSON, finishReasonOf, responseEventToChatChunks, responsesSSEToChatSSE,
  nextSSEFrame, parseSSEFrame, makeDirectFetch,
}
