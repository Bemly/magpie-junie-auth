import test from "node:test"
import assert from "node:assert/strict"
import { messagesToPrompt, parseCliOutput, decodeCliStdout, completionBody, streamChunks, modelsResponse } from "../bridge-server.mjs"

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


test("decodeCliStdout decodes GBK bytes from Chinese Windows CLI", () => {
  // 真实捕获的 GBK 字节（"用中文回答“你好"）+ ASCII JSON 结构
  const gbkJson = Buffer.from(
    "7b226e616d65223a22" + "d3c3d6d0cec4bbd8b4f0a1b0c4e3bac3" + "222c226572726f7273223a5b5d7d",
    "hex",
  )
  const decoded = decodeCliStdout(gbkJson)
  assert.match(decoded, /用中文回答/)
  const obj = parseCliOutput(gbkJson)
  assert.equal(obj.name, "用中文回答“你好")
})

test("decodeCliStdout keeps UTF-8 bytes intact", () => {
  const b = Buffer.from('{"name":"英文 ok"}', "utf8")
  assert.equal(decodeCliStdout(b), '{"name":"英文 ok"}')
  assert.equal(parseCliOutput(b).name, "英文 ok")
})
