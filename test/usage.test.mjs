// usage 映射 + 入口导出的插件形状
import test from "node:test"
import assert from "node:assert/strict"
import { toMagpieUsage, fetchAuthInfo } from "../lib/usage.mjs"
import pluginDefault, { JuniePlugin, _internal } from "../index.mjs"

test("toMagpieUsage maps the real /auth/test shape", () => {
  const out = toMagpieUsage({
    balanceLeft: 0, balanceUnit: "CREDITS", licenseType: "NONE", active: false, username: "rina",
  })
  assert.equal(out.plan, "NONE")
  assert.equal(out.user, "rina")
  assert.equal(out.balance, "0 CREDITS")
  assert.deepEqual(out.windows, [])
  assert.match(out.error, /NO_LICENSE/)
})

test("toMagpieUsage active account has no error", () => {
  const out = toMagpieUsage({ balanceLeft: 5, balanceUnit: "USD", licenseType: "PRO", active: true })
  assert.equal(out.error, "")
  assert.equal(out.balance, "5 USD")
})

test("entry exposes exactly one plugin function and default", () => {
  assert.equal(pluginDefault.id, "junie")
  assert.equal(pluginDefault.server, JuniePlugin)
  assert.equal(typeof JuniePlugin, "function")
  assert.ok(_internal.makeFetch)
})

test("plugin hooks shape (config/auth/provider)", async () => {
  const hooks = await JuniePlugin()
  assert.equal(typeof hooks.config, "function")
  assert.equal(hooks.auth.provider, "junie")
  assert.equal(hooks.auth.methods.length, 4)
  // CLI 导入用 oauth（完整保存 refresh/expires，magpie 才能续期/多账号轮换）
  assert.equal(hooks.auth.methods[0].type, "oauth")
  assert.equal(hooks.auth.methods[2].type, "api")
  // 第 4 个：直接粘贴 refresh token，prompts + authorize → 宿主标记 keyAsked
  const rt = hooks.auth.methods[3]
  assert.equal(rt.type, "api")
  assert.equal(rt.prompts?.[0]?.key, "refresh")
  assert.equal(typeof rt.authorize, "function")
  assert.equal(hooks.provider.id, "junie")
  assert.equal(typeof hooks.auth.refresh, "function")
  assert.equal(typeof hooks.auth.usage, "function")
})

test("config hook declares provider without overwriting user config", async () => {
  const hooks = await JuniePlugin()
  const cfg = { provider: { junie: { api: "user-override" } } }
  await hooks.config(cfg)
  assert.equal(cfg.provider.junie.api, "user-override")
  const fresh = {}
  await hooks.config(fresh)
  // 直连/桥接都只提供免费档的 junie-lite（底层 GPT-6 Luna）
  assert.ok(fresh.provider.junie.models["junie-lite"])
})

import { setFetchImpl, clearFetchImpl } from "../lib/proxy.mjs"

test("fetchAuthInfo uses global fetch with Bearer header", async () => {
  let seen
  setFetchImpl(async (url, init) => {
    seen = { url, init }
    return new Response(JSON.stringify({ active: true, balanceLeft: 1 }))
  })
  try {
    const info = await fetchAuthInfo("J")
    assert.equal(info.active, true)
    assert.equal(seen.init.headers.Authorization, "Bearer J")
    assert.ok(seen.url.endsWith("/auth/test"))
  } finally { clearFetchImpl() }
})

test("bridge mode: config declares only junie-lite at bridge URL", async () => {
  const hooks = await JuniePlugin({}, { bridgeUrl: "http://127.0.0.1:4141/v1" })
  const cfg = {}
  await hooks.config(cfg)
  assert.equal(cfg.provider.junie.api, "http://127.0.0.1:4141/v1")
  assert.deepEqual(Object.keys(cfg.provider.junie.models), ["junie-lite"])
})

test("bridge mode: loader rewrites host to bridge and keeps body", async () => {
  const hooks = await JuniePlugin({}, { bridgeUrl: "http://127.0.0.1:4141/v1" })
  const loader = await hooks.auth.loader(async () => ({ type: "oauth", access: "T" }))
  assert.equal(loader.baseURL, "http://127.0.0.1:4141/v1")
  const seen = []
  setFetchImpl(async (url, init) => { seen.push({ url, init }); return new Response("ok") })
  try {
    await loader.fetch("https://ingrazzio-cloud-prod.labs.jb.gg/v1/chat/completions", { method: "POST", body: "{}" })
    assert.equal(seen[0].url, "http://127.0.0.1:4141/v1/chat/completions")
    assert.equal(seen[0].init.body, "{}")
  } finally { clearFetchImpl() }
})

test("bridge mode: provider.models returns only junie-lite", async () => {
  const hooks = await JuniePlugin({}, { bridgeUrl: "http://127.0.0.1:4141/v1" })
  const models = await hooks.provider.models({})
  assert.deepEqual(Object.keys(models), ["junie-lite"])
})

test("direct mode: loader with no auth returns 401 instead of throwing", async () => {
  const hooks = await JuniePlugin()
  for (const auth of [null, undefined, { type: "oauth" }]) {
    const loader = await hooks.auth.loader(async () => auth)
    assert.ok(loader.apiKey !== undefined)
    const res = await loader.fetch("http://x/v1/chat/completions", { method: "POST", body: "{}" })
    assert.equal(res.status, 401)
    const j = await res.json()
    assert.match(j.error.message, /尚未登录|未登录/)
  }
})

test("junie-lite declares image capability so it appears in magpie vision models", async () => {
  const hooks = await JuniePlugin()
  const models = await hooks.provider.models({})
  const m = models["junie-lite"]
  // magpie reads capabilities.input (not modalities) from a plugin's models hook
  assert.equal(m.capabilities.input.image, true)
  assert.equal(m.capabilities.input.text, true)
  assert.equal(m.capabilities.attachment, true)
})
