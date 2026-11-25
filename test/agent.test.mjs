// agent 场景回归测试：tools 双向转换、role:tool、图片、流式增量与 usage。
import test from "node:test"
import assert from "node:assert/strict"
import {
  toResponsesInput, toResponsesBody, toResponsesTools,
  fromResponsesJSON, responsesSSEToChatSSE, responseEventToChatChunks,
  makeDirectFetch, toChatUsage,
} from "../lib/direct.mjs"
import { setFetchImpl, clearFetchImpl } from "../lib/proxy.mjs"

const TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get weather",
    parameters: { type: "object", properties: { city: { type: "string" } } },
  },
}

test("toResponsesTools 转发 tools 与 tool_choice", () => {
  const r = toResponsesTools({ tools: [TOOL], tool_choice: { type: "function", function: { name: "get_weather" } } })
  assert.equal(r.tools[0].type, "function")
  assert.equal(r.tools[0].name, "get_weather")       // 不是 tools[0].function.name
  assert.equal(r.tools[0].description, "Get weather")
  assert.deepEqual(r.tool_choice, { type: "function", name: "get_weather" })
  const b = toResponsesBody({ messages: [], tools: [TOOL], tool_choice: "auto" })
  assert.equal(b.tools.length, 1)
  assert.equal(b.tool_choice, "auto")
})

test("assistant.tool_calls 与 role:tool 转成 Responses item（不再是空 content / 非法 role）", () => {
  const { input } = toResponsesInput([
    { role: "user", content: "天气?" },
    { role: "assistant", content: null, tool_calls: [
      { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } },
    ] },
    { role: "tool", tool_call_id: "call_1", content: "sunny" },
  ])
  assert.ok(!input.some((x) => x.role === "tool"), "Responses 里不应出现 role:tool")
  assert.deepEqual(input[1], {
    type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"SF"}',
  })
  assert.deepEqual(input[2], { type: "function_call_output", call_id: "call_1", output: "sunny" })
})

test("assistant tool_call 的 arguments 为对象时转成 JSON 字符串", () => {
  const { input } = toResponsesInput([{ role: "assistant", tool_calls: [
    { id: "c1", type: "function", function: { name: "f", arguments: { city: "SF" } } },
  ] }])
  assert.equal(typeof input[0].arguments, "string")
  assert.deepEqual(JSON.parse(input[0].arguments), { city: "SF" })
})

test("多模态 content parts 映射为 input_text / input_image，不静默丢", () => {
  const { input } = toResponsesInput([{ role: "user", content: [
    { type: "text", text: "看图" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAA", detail: "high" } },
  ] }])
  const parts = input[0].content
  assert.deepEqual(parts[0], { type: "input_text", text: "看图" })
  assert.deepEqual(parts[1], { type: "input_image", image_url: "data:image/png;base64,AAA", detail: "high" })
})

test("toResponsesBody 只转发上游支持的字段；temperature/top_p/stop 主动丢弃", () => {
  const b = toResponsesBody({
    messages: [],
    temperature: 0.2, top_p: 0.9, parallel_tool_calls: false, stop: ["END"],
    response_format: { type: "json_schema", json_schema: { name: "out", schema: { type: "object" } } },
  })
  // gpt-6-luna 不支持这些，转发会 400
  assert.equal(b.temperature, undefined)
  assert.equal(b.top_p, undefined)
  assert.equal(b.stop_sequences, undefined)
  assert.equal(b.parallel_tool_calls, false)
  assert.deepEqual(b.text.format, { type: "json_schema", name: "out", schema: { type: "object" } })
})

test("fromResponsesJSON 把 function_call 转回 tool_calls，finish_reason=tool_calls", () => {
  const c = fromResponsesJSON({
    id: "resp_x", created_at: 1,
    output: [{ type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"SF"}' }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  }, "junie-lite")
  assert.equal(c.choices[0].finish_reason, "tool_calls")
  assert.deepEqual(c.choices[0].message.tool_calls, [{
    id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' },
  }])
  assert.equal(c.choices[0].message.content, "")
  assert.equal(c.usage.total_tokens, 15)
})

test("SSE: function_call 增量事件转 chat tool_calls delta", () => {
  const sse = [
    'data: {"type":"response.output_item.added","item":{"id":"item1","type":"function_call","call_id":"call_1","name":"get_weather","arguments":""}}',
    "",
    'data: {"type":"response.function_call_arguments.delta","item_id":"item1","delta":"{\\"city\\":"}',
    "",
    'data: {"type":"response.function_call_arguments.delta","item_id":"item1","delta":"\\"SF\\"}"}',
    "",
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}',
    "",
  ].join("\n")
  const out = new TextDecoder().decode(responsesSSEToChatSSE(new TextEncoder().encode(sse)))
  assert.match(out, /"id":"call_1"/)
  assert.match(out, /"name":"get_weather"/)
  assert.match(out, /city/)
  assert.match(out, /"finish_reason":"tool_calls"/)
  assert.match(out, /"usage":\{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15\}/)
  assert.ok(out.includes("[DONE]"))
})

test("SSE: 纯文本流也带 usage", () => {
  const sse = [
    'data: {"type":"response.output_text.delta","delta":"OK"}',
    "",
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}',
    "",
  ].join("\n")
  const out = new TextDecoder().decode(responsesSSEToChatSSE(new TextEncoder().encode(sse)))
  assert.match(out, /"content":"OK"/)
  assert.match(out, /"usage":\{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3\}/)
})

test("directFetch 流式逐块输出，不缓冲整段", async () => {
  let pulled = 0
  setFetchImpl(async () => new Response(new ReadableStream({
    async pull(controller) {
      pulled++
      if (pulled === 1) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"A"}\n\n'))
      } else if (pulled === 2) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"B"}\n\n'))
      } else {
        controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}\n\n'))
        controller.close()
      }
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } }))

  try {
    const fetch = makeDirectFetch({ access: "tok" })
    const res = await fetch("http://x/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "junie-lite", stream: true, messages: [{ role: "user", content: "hi" }] }),
    })
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    const got = []
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      got.push(dec.decode(value))
    }
    assert.ok(got.length >= 2, `应分多次吐出，实际 ${got.length} 次`)
    assert.match(got.join(""), /"content":"A"/)
    assert.match(got.join(""), /"content":"B"/)
    assert.match(got.join(""), /"usage"/)
    assert.match(got.join(""), /\[DONE\]/)
  } finally {
    clearFetchImpl()
  }
})

test("directFetch 流式处理上游 CRLF 分隔的 SSE（真机上游用 \\r\\n\\r\\n）", async () => {
  setFetchImpl(async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        'data: {"type":"response.output_text.delta","delta":"你好"}\r\n\r\n' +
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}\r\n\r\n',
      ))
      controller.close()
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } }))
  try {
    const fetch = makeDirectFetch({ access: "tok" })
    const res = await fetch("http://x/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "junie-lite", stream: true, messages: [{ role: "user", content: "hi" }] }),
    })
    const text = await new Response(res.body).text()
    assert.match(text, /"content":"你好"/)
    assert.match(text, /"usage"/)
    assert.match(text, /\[DONE\]/)
  } finally {
    clearFetchImpl()
  }
})

test("SSE: 上游不发 output_item.added 时 delta 仍能建立 tool index", () => {
  const sse = [
    'data: {"type":"response.function_call_arguments.delta","item_id":"it1","delta":"{}"}',
    "",
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
    "",
  ].join("\n")
  const out = new TextDecoder().decode(responsesSSEToChatSSE(new TextEncoder().encode(sse)))
  assert.match(out, /"tool_calls":\[{"index":0/)
  assert.match(out, /"finish_reason":"tool_calls"/)
})

test("SSE: function_call_arguments.done 补齐缺失的 delta", () => {
  const sse = [
    'data: {"type":"response.output_item.added","item":{"id":"it1","type":"function_call","call_id":"c1","name":"f","arguments":""}}',
    "",
    'data: {"type":"response.function_call_arguments.done","item_id":"it1","arguments":"{\\"a\\":1}"}',
    "",
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
    "",
  ].join("\n")
  const out = new TextDecoder().decode(responsesSSEToChatSSE(new TextEncoder().encode(sse)))
  assert.match(out, /\\"a\\":1/)  // JSON 字符串里引号被转义
})

test("fromResponsesJSON: incomplete+max_output_tokens → finish_reason=length", () => {
  const c = fromResponsesJSON({
    status: "incomplete", status_details: { reason: "max_output_tokens" },
    output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
  }, "junie-lite")
  assert.equal(c.choices[0].finish_reason, "length")
})

test("fromResponsesJSON: refusal 内容不被丢成空文本", () => {
  const c = fromResponsesJSON({
    output: [{ type: "message", content: [{ type: "refusal", refusal: "I refuse" }] }],
  }, "junie-lite")
  assert.match(c.choices[0].message.content, /refusal: I refuse/)
})

test("SSE: response.incomplete 按 status_details 给 length", () => {
  const sse = [
    'data: {"type":"response.incomplete","response":{"status":"incomplete","status_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
    "",
  ].join("\n")
  const out = new TextDecoder().decode(responsesSSEToChatSSE(new TextEncoder().encode(sse)))
  assert.match(out, /"finish_reason":"length"/)
})

test("fromResponsesJSON: reasoning summary → reasoning_content，不进 content", () => {
  const c = fromResponsesJSON({
    output: [
      { type: "reasoning", summary: [{ type: "summary_text", text: "step1" }, { type: "summary_text", text: "step2" }] },
      { type: "message", content: [{ type: "output_text", text: "answer" }] },
    ],
  }, "junie-lite")
  assert.equal(c.choices[0].message.content, "answer")
  assert.equal(c.choices[0].message.reasoning_content, "step1\nstep2")
})

test("SSE: output_text.done 补齐缺失的 delta 文本", () => {
  const sse = [
    'data: {"type":"response.output_text.done","text":"HELLO"}',
    "",
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
    "",
  ].join("\n")
  const out = new TextDecoder().decode(responsesSSEToChatSSE(new TextEncoder().encode(sse)))
  assert.match(out, /"content":"HELLO"/)
  const texts = [...out.matchAll(/"content":"([^"]*)"/g)].map((m) => m[1])
  assert.equal(texts.join(""), "HELLO") // 不重复
})

test("SSE: 上游 failed/error 事件透出原因而非空成功", () => {
  const sse = [
    'data: {"type":"response.failed","response":{"error":{"message":"rate limited"}}}',
    "",
  ].join("\n")
  const out = new TextDecoder().decode(responsesSSEToChatSSE(new TextEncoder().encode(sse)))
  assert.match(out, /rate limited/)
  assert.match(out, /\[DONE\]/)
})

test("fromResponsesJSON: HTTP 200 但 error 字段不吞", () => {
  const c = fromResponsesJSON({ status: "failed", error: { message: "no license" }, output: [] }, "junie-lite")
  assert.match(c.choices[0].message.content, /no license/)
})

test("directFetch 错误响应透传 retry-after", async () => {
  setFetchImpl(async () => new Response('{"error":"429"}', {
    status: 429,
    headers: { "retry-after": "30", "x-ratelimit-remaining-requests": "0" },
  }))
  try {
    const fetch = makeDirectFetch({ access: "tok" })
    const res = await fetch("http://x/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "junie-lite", messages: [] }),
    })
    assert.equal(res.status, 429)
    assert.equal(res.headers.get("retry-after"), "30")
    assert.equal(res.headers.get("x-ratelimit-remaining-requests"), "0")
  } finally {
    clearFetchImpl()
  }
})

test("system 含图片时保留在 input 而非塞进 instructions 丢失", () => {
  const { input, instructions } = toResponsesInput([{ role: "system", content: [
    { type: "text", text: "SYS" },
    { type: "image_url", image_url: { url: "data:image/png;base64,X" } },
  ] }])
  assert.equal(instructions, undefined)
  assert.equal(input.length, 1)
  assert.equal(input[0].role, "system")
  assert.deepEqual(input[0].content[1], { type: "input_image", image_url: "data:image/png;base64,X" })
})

test("directFetch 流式请求但上游返回纯 JSON 时不丢内容", async () => {
  setFetchImpl(async () => new Response(JSON.stringify({
    id: "resp_x", created_at: 1,
    output: [{ type: "message", content: [{ type: "output_text", text: "FALLBACK" }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { "Content-Type": "application/json" } }))
  try {
    const fetch = makeDirectFetch({ access: "tok" })
    const res = await fetch("http://x/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "junie-lite", stream: true, messages: [{ role: "user", content: "hi" }] }),
    })
    const text = await new Response(res.body).text()
    assert.match(text, /FALLBACK/)
    assert.match(text, /\[DONE\]/)
  } finally {
    clearFetchImpl()
  }
})

test("SSE 混用 LF/CRLF 分隔符时不丢帧、顺序正确", () => {
  const sse = [
    'data: {"type":"response.output_text.delta","delta":"A"}', "",
    'data: {"type":"response.output_text.delta","delta":"B"}', "",
    'data: {"type":"response.output_text.delta","delta":"C"}', "",
  ].join("\n").replace('"delta":"B"}\n', '"delta":"B"}\r\n') // 混入 CRLF 帧
  const out = new TextDecoder().decode(responsesSSEToChatSSE(new TextEncoder().encode(sse)))
  const texts = [...out.matchAll(/"content":"([ABC])"/g)].map((m) => m[1])
  assert.deepEqual(texts, ["A", "B", "C"])
})

test("SSE 最后一帧无结尾空行也处理", () => {
  const sse = 'data: {"type":"response.output_text.delta","delta":"LAST"}'
  const out = new TextDecoder().decode(responsesSSEToChatSSE(new TextEncoder().encode(sse)))
  assert.match(out, /"content":"LAST"/)
})

test("directFetch 非流式：请求体含 tools，响应含 tool_calls", async () => {
  let sent
  setFetchImpl(async (url, init) => {
    sent = JSON.parse(init.body)
    return new Response(JSON.stringify({
      id: "resp_1", created_at: 1,
      output: [{ type: "function_call", call_id: "call_9", name: "get_weather", arguments: "{}" }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }), { status: 200 })
  })
  try {
    const fetch = makeDirectFetch({ access: "tok" })
    const res = await fetch("http://x/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "junie-lite", stream: false,
        messages: [{ role: "user", content: "天气?" }],
        tools: [TOOL], tool_choice: "auto",
      }),
    })
    assert.equal(sent.tools[0].name, "get_weather")
    assert.equal(sent.tool_choice, "auto")
    const c = await res.json()
    assert.equal(c.choices[0].finish_reason, "tool_calls")
    assert.equal(c.choices[0].message.tool_calls[0].id, "call_9")
  } finally {
    clearFetchImpl()
  }
})

test("toChatUsage 透传缓存命中字段（cached_tokens / cache_write_tokens）", () => {
  const u = toChatUsage({
    input_tokens: 100, output_tokens: 20, total_tokens: 120,
    input_tokens_details: { cached_tokens: 80, cache_write_tokens: 10 },
    output_tokens_details: { reasoning_tokens: 5 },
  })
  assert.equal(u.prompt_tokens_details.cached_tokens, 80)
  assert.equal(u.prompt_tokens_details.cache_write_tokens, 10)
  assert.equal(u.completion_tokens_details.reasoning_tokens, 5)
  // 无缓存字段时不凭空造
  const plain = toChatUsage({ input_tokens: 1, output_tokens: 2, total_tokens: 3 })
  assert.equal(plain.prompt_tokens_details, undefined)
})
