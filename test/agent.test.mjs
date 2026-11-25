// agent 场景回归测试：tools 双向转换、role:tool、图片、流式增量与 usage。
import test from "node:test"
import assert from "node:assert/strict"
import {
  toResponsesInput, toResponsesBody, toResponsesTools,
  fromResponsesJSON, responsesSSEToChatSSE, responseEventToChatChunks,
  makeDirectFetch,
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

test("多模态 content parts 映射为 input_text / input_image，不静默丢", () => {
  const { input } = toResponsesInput([{ role: "user", content: [
    { type: "text", text: "看图" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAA", detail: "high" } },
  ] }])
  const parts = input[0].content
  assert.deepEqual(parts[0], { type: "input_text", text: "看图" })
  assert.deepEqual(parts[1], { type: "input_image", image_url: "data:image/png;base64,AAA", detail: "high" })
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
