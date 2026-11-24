// 端到端验证：CLI 导入 → refresh → 插件 usage hook → 插件 fetch 模块打 /auth/test
// 只打印状态，不打印 token
import { readCliCredentials } from "../lib/credentials.mjs"
import { refreshAccessToken } from "../lib/auth.mjs"
import { usageHook, fetchAuthInfo } from "../lib/usage.mjs"
import { makeFetch } from "../lib/fetch.mjs"

const r = await readCliCredentials()
if (!r.ok) { console.log("IMPORT FAIL:", r.reason); process.exit(1) }
console.log("1. CLI import OK, account:", r.auth.accountId)

let auth = r.auth
if (!auth.expires || auth.expires < Date.now() + 90_000) {
  auth = { ...auth, ...(await refreshAccessToken(auth)) }
  console.log("2. refresh OK, expires:", new Date(auth.expires).toISOString())
} else console.log("2. token still valid")

// 插件 usage hook（走代理）
const u = await usageHook(async () => auth)
console.log("3. usage hook:", JSON.stringify(u))

// 插件 fetch 模块：直接用它打一个最小探测（GET /auth/test，body 为空）
const f = makeFetch(auth, {})
try {
  const res = await f("https://ingrazzio-cloud-prod.labs.jb.gg/auth/test", { method: "GET", headers: {} })
  console.log("4. plugin fetch /auth/test:", res.status, (await res.text()).slice(0, 150))
} catch (e) { console.log("4. plugin fetch FAIL:", e.message) }
