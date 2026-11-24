import test from "node:test"
import assert from "node:assert/strict"
import { messagesToPrompt, parseCliOutput, completionBody, streamChunks, modelsResponse } from "../bridge-server.mjs"

test("messagesToPrompt keeps roles and flattens content parts", () => {
  const prompt = messagesToPrompt([
    { role: "system", content: "be brief" },
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: "hi" },
    { role: "user", content: "again" },
  ])
  assert.match(prompt, /## 系统指令\nbe brief/)
  assert.match(prompt, /## 用户\nhello/)
  assert.match(prompt, /## 助手此前回复\nhi/)
  assert.match(prompt, /## 用户\nagain/)
})

test("parseCliOutput finds the JSON line among CLI logs", () => {
  const stdout = [
    "Junie 26.11.2 (4100.11) (pid=1): log file: C:\\x.log",
    "Junie update 26.11.3 is available.",
    '{"sessionId":"s1","result":"OK","errors":[],"llmUsage":[]}',
    "some trailing log",
  ].join("\n")
  assert.equal(parseCliOutput(stdout).result, "OK")
})

test("parseCliOutput returns null when no JSON", () => {
  assert.equal(parseCliOutput("just logs"), null)
})

test("completionBody wraps result as assistant message", () => {
  const b = completionBody("hello", "junie-lite")
  assert.equal(b.object, "chat.completion")
  assert.equal(b.choices[0].message.role, "assistant")
  assert.equal(b.choices[0].message.content, "hello")
  assert.equal(b.choices[0].finish_reason, "stop")
})

test("streamChunks emits role, content chunks and [DONE]", () => {
  const sse = streamChunks("abcdef", "junie-lite")
  assert.match(sse, /"role":"assistant"/)
  assert.match(sse, /"content":"abcdef"/)
  assert.match(sse, /"finish_reason":"stop"/)
  assert.match(sse, /data: \[DONE\]/)
})

test("modelsResponse exposes junie-lite", () => {
  const r = modelsResponse()
  assert.ok(r.data.some((m) => m.id === "junie-lite"))
})
