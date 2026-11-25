// 直连 Responses 协议的字段测试（用抓包的精确值断言）。
import test from "node:test"
import assert from "node:assert/strict"
import {
  directHeaders, toResponsesInput, toResponsesBody,
  fromResponsesJSON, responsesSSEToChatSSE,
} from "../lib/direct.mjs"

test("directHeaders 含 CLI 抓包的精确许可头", () => {
  const h = directHeaders("tok", {})
  assert.equal(h["X-LLM-Model"], "openai")
  assert.equal(h["X-Forced-License-Free"], "2")
  assert.equal(h["X-Accept-EAP-License"], "false")
  assert.equal(h["X-Accept-Release-License"], "false")
  assert.equal(h["X-Client-Feature-Id"], "junie")
  assert.equal(h["Grazie-Agent"], '{"name":"junie:cli","version":"4171.6:4171.6"}')
  assert.equal(h["User-Agent"], "junie-cli-batch:26.11.3")
  assert.equal(h["Authorization"], "Bearer tok")
})

test("toResponsesInput 把 system 提为 instructions", () => {
  const { input, instructions } = toResponsesInput([
    { role: "system", content: "SYS" },
    { role: "user", content: "HI" },
  ])
  assert.equal(instructions, "SYS")
  assert.deepEqual(input, [{ role: "user", content: "HI" }])
})

test("toResponsesBody 用 wireName 与 Responses 字段", () => {
  const b = toResponsesBody({ messages: [{ role: "user", content: "hi" }], stream: false })
  assert.equal(b.model, "gpt-6-luna")
  assert.equal(b.stream, false)
  assert.equal(b.store, false)
  assert.deepEqual(b.text, { format: { type: "text" } })
  assert.deepEqual(b.reasoning, { effort: "low" })
  assert.equal(b.prompt_cache_retention, "24h")
})

test("fromResponsesJSON 取 output_text", () => {
  const r = {
    id: "resp_1", created_at: 100,
    output: [{ type: "message", content: [
      { type: "output_text", text: "你" },
      { type: "output_text", text: "好" },
    ] }],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  }
  const c = fromResponsesJSON(r, "junie-lite")
  assert.equal(c.choices[0].message.content, "你好")
  assert.equal(c.usage.total_tokens, 5)
  assert.equal(c.model, "junie-lite")
})

test("responsesSSEToChatSSE 输出 delta 与 [DONE]", () => {
  const sse = [
    "event: response.output_text.delta",
    'data: {"type":"response.output_text.delta","delta":"O"}',
    "",
    "event: response.output_text.delta",
    'data: {"type":"response.output_text.delta","delta":"K"}',
    "",
    'data: {"type":"response.completed"}',
    "",
  ].join("\n")
  const out = new TextDecoder().decode(responsesSSEToChatSSE(new TextEncoder().encode(sse)))
  assert.match(out, /"content":"O"/)
  assert.match(out, /"content":"K"/)
  assert.match(out, /"finish_reason":"stop"/)
  assert.ok(out.includes("[DONE]"))
})
