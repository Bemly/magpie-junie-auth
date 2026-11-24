// fetch 链路：URL 改写、header 合并、477 重试、SSE 透传（mock fetch）
import test from "node:test"
import assert from "node:assert/strict"
import { makeFetch, bodyModel, upstreamUrl } from "../lib/fetch.mjs"
import { setFetchImpl, clearFetchImpl } from "../lib/proxy.mjs"

function mockGlobal(responder) {
  const calls = []
  setFetchImpl(async (...args) => {
    calls.push(args)
    return responder(...args)
  })
  return { calls, restore: () => clearFetchImpl() }
}

test("bodyModel parses JSON body (string and bytes)", () => {
  assert.equal(bodyModel(JSON.stringify({ model: "claude-sonnet-4-6" })), "claude-sonnet-4-6")
  assert.equal(bodyModel(new TextEncoder().encode(JSON.stringify({ model: "openai-gpt4.1" }))), "openai-gpt4.1")
  assert.equal(bodyModel("not json"), undefined)
})

test("upstreamUrl routes by model family", () => {
  assert.ok(upstreamUrl("https://x/v1/chat/completions", "anthropic", {}).endsWith("/v1/messages"))
  assert.ok(upstreamUrl("https://x/v1/messages", "openai", {}).endsWith("/v1/chat/completions"))
  assert.ok(upstreamUrl("https://x/v1/chat/completions", "vllm", {}).endsWith("/llm/vllm/v1/chat/completions"))
})

test("fetch injects Junie auth header, overrides AI SDK apiKey header", async () => {
  const { calls, restore } = mockGlobal(async () => new Response("ok"))
  try {
    const f = makeFetch({ type: "oauth", access: "JTOKEN", metadata: {} }, {})
    await f("https://ingrazzio-cloud-prod.labs.jb.gg/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer ai-sdk-key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [], context_management: { x: 1 } }),
    })
    const [, init] = calls[0]
    const h = new Headers(init.headers)
    assert.equal(h.get("Authorization"), "Bearer JTOKEN")
    assert.equal(h.get("X-Keep-Path"), "true")
    const body = JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body))
    assert.equal("context_management" in body, false)
  } finally { restore() }
})

test("fetch maps openai profile id to upstream model name", async () => {
  const { calls, restore } = mockGlobal(async () => new Response("ok"))
  try {
    const f = makeFetch({ type: "api", key: "K" }, {})
    await f("https://x/v1/chat/completions", {
      method: "POST",
      headers: {},
      body: JSON.stringify({ model: "openai-gpt4.1", messages: [] }),
    })
    const body = JSON.parse(calls[0][1].body)
    assert.equal(body.model, "gpt-4.1-2025-04-14")
  } finally { restore() }
})

test("477 retries once without X-Free-Google-Api", async () => {
  let n = 0
  const { calls, restore } = mockGlobal(async () => {
    n++
    return n === 1 ? new Response("free tier gone", { status: 477 }) : new Response("ok", { status: 200 })
  })
  try {
    const auth = { type: "oauth", access: "J", metadata: { freeGoogleApi: true, license: "standard" } }
    const f = makeFetch(auth, {})
    const res = await f("https://x/v1/messages", { method: "POST", body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }) })
    assert.equal(res.status, 200)
    assert.equal(calls.length, 2)
    assert.equal(new Headers(calls[0][1].headers).get("X-Free-Google-Api"), "true")
    assert.equal(new Headers(calls[1][1].headers).get("X-Free-Google-Api"), null)
    assert.equal(auth.metadata.freeGoogleApi, false)
  } finally { restore() }
})

test("477 with freeGoogleApi disabled: no retry", async () => {
  let n = 0
  const { calls, restore } = mockGlobal(async () => { n++; return new Response("x", { status: 477 }) })
  try {
    const f = makeFetch({ type: "oauth", access: "J", metadata: { license: "standard" } }, { freeGoogleApi: false })
    const res = await f("https://x/v1/messages", { method: "POST", body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }) })
    assert.equal(res.status, 477)
    assert.equal(calls.length, 1)
  } finally { restore() }
})

test("SSE stream body passed through unchanged", async () => {
  const sse = 'event: message_start\ndata: {"type":"message_start"}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta"}\n\n'
  const { restore } = mockGlobal(async () => new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }))
  try {
    const f = makeFetch({ type: "oauth", access: "J", metadata: {} }, {})
    const res = await f("https://x/v1/messages", { method: "POST", body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [], stream: true }) })
    assert.equal(await res.text(), sse)
  } finally { restore() }
})
