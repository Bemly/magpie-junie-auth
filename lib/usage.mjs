// auth.usage：GET /auth/test → magpie 用量卡片。
// 实测（2026-11-24，走代理）：
//   {"balanceLeft":0.0,"balanceUnit":"CREDITS","licenseType":"NONE","authType":"","active":false}
// 上游不给窗口百分比，windows 留空、不要编造 used=0。
// 401 → signIn:"expired" 让 magpie 标记账号需重新登录。

import { UPSTREAM } from "./constants.mjs"
import { proxyFetch } from "./proxy.mjs"

export async function fetchAuthInfo(token, { freeGoogleApi = true, proxy } = {}) {
  // /auth/test 用与 Responses 一致的 CLI 许可头，免费档才返回 GZL 而不是 NO_LICENSE。
  const headers = {
    Authorization: `Bearer ${token}`,
    "X-LLM-Model": "openai",
    "X-Keep-Path": "true",
    "X-Forced-License-Free": "2",
    "X-Accept-EAP-License": "false",
    "X-Accept-Release-License": "false",
    "Grazie-Agent": '{"name":"junie:cli","version":"4171.6:4171.6"}',
    "X-Client-Feature-Id": "junie",
    "User-Agent": "junie-cli-batch:26.11.3",
  }
  if (freeGoogleApi) headers["X-Free-Google-Api"] = "true"
  const res = await proxyFetch(`${UPSTREAM.ingrazzio}${UPSTREAM.authTestPath}`, { headers }, { proxy })
  const text = await res.text()
  if (!res.ok) {
    const err = new Error(`auth/test failed: ${res.status} ${text.slice(0, 200)}`)
    err.status = res.status
    throw err
  }
  return JSON.parse(text)
}

/** /auth/test 响应 → magpie usage 形状。 */
export function toMagpieUsage(info) {
  const balance = info?.balanceLeft != null
    ? `${info.balanceLeft} ${info.balanceUnit ?? "CREDITS"}`
    : ""
  const active = info?.active
  return {
    plan: info?.licenseType || "",
    user: info?.username || "",
    balance,
    windows: [],
    error: active === false ? "账号没有有效的 JetBrains AI 订阅（NO_LICENSE）" : "",
  }
}

/** magpie auth.usage hook。 */
export async function usageHook(getAuth) {
  const auth = await getAuth()
  if (!auth || (auth.type !== "oauth" && auth.type !== "api")) {
    return { error: "尚未登录 Junie", windows: [] }
  }
  const token = auth.access ?? auth.key
  try {
    const info = await fetchAuthInfo(token, { freeGoogleApi: auth.metadata?.freeGoogleApi !== false })
    return toMagpieUsage(info)
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      return { error: "Junie 登录失效或区域受限，请重新登录/检查代理", windows: [], signIn: "expired" }
    }
    return { error: `无法读取 Junie 额度：${String(err.message ?? err).slice(0, 200)}`, windows: [] }
  }
}

export const _internal = { fetchAuthInfo, toMagpieUsage, usageHook }
