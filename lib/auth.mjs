// Junie 登录/续期：CLI 凭据复用（见 credentials.mjs）、浏览器 PKCE、API key。
//
// PKCE 流程（复刻 Junie CLI）：
//   authorize()  → 起本地回调 server（端口 62345-62364），生成 verifier/state，
//                  返回 url + callback；magpie 打开浏览器让用户登录。
//   callback()   → 收到 ?code=&state= → 校验 state → 换 token → 成功结果。
// verifier/state 存在模块级 Map，key 是本次登录的 signal（一次性会话状态，不是账号状态）；
// signal.abort 时清理 server 并 reject，避免端口占用与悬挂 Promise。

import { createHash, randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { OAUTH } from "./constants.mjs"
import { proxyFetch } from "./proxy.mjs"

export function generatePKCE() {
  const codeVerifier = randomBytes(32).toString("base64url")
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url")
  return { codeVerifier, codeChallenge }
}

export function buildAuthUrl({ callbackPort, codeChallenge, state }) {
  const redirectUri = `http://localhost:${callbackPort}`
  // 与 Junie CLI buildAuthUrl 逐字一致（scope 用 %20 而不是 URLSearchParams 的 +）
  return `${OAUTH.loginInitialUrl}?client_id=${OAUTH.clientId}&scope=${encodeURIComponent(OAUTH.scopes)}&state=${state}&code_challenge=${codeChallenge}&redirect_uri=${encodeURIComponent(redirectUri)}`
}

/** OAuth 表单换 token（authorization_code 或 refresh_token）。 */
export async function exchangeToken(params) {
  const body = new URLSearchParams({ client_id: OAUTH.clientId, ...params })
  const res = await proxyFetch(OAUTH.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  })
  const text = await res.text()
  if (!res.ok) {
    let body
    try { body = JSON.parse(text) } catch { body = null }
    const err = new Error(`token exchange failed: ${res.status} ${text.slice(0, 300)}`)
    err.status = res.status
    err.code = body?.error ?? null
    throw err
  }
  return JSON.parse(text)
}

/** refresh token → magpie 的续期结果。 */
export async function refreshAccessToken(auth) {
  if (!auth?.refresh) return null
  try {
    const t = await exchangeToken({ grant_type: "refresh_token", refresh_token: auth.refresh })
    // 上游 Bearer 用 id_token；access_token 只用于 userinfo
    const access = t.id_token ?? t.access_token ?? auth.access
    return {
      access,
      key: access, // magpie 续期后仍可能按 key 取 apiKey，保持同步
      accessToken: t.access_token ?? auth.accessToken,
      idToken: t.id_token ?? auth.idToken,
      refresh: t.refresh_token ?? auth.refresh,
      expires: t.expires_in ? Date.now() + t.expires_in * 1000 : auth.expires,
    }
  } catch (err) {
    if (err.code === "invalid_grant") {
      throw Object.assign(new Error("Junie 登录已失效，请重新登录"), { signIn: "expired" })
    }
    throw err
  }
}

/** userinfo → accountId（email / sub），失败返回空串（不阻塞登录）。 */
export async function resolveAccountId(access) {
  try {
    const res = await proxyFetch(OAUTH.userinfoEndpoint, { headers: { Authorization: `Bearer ${access}` } })
    if (!res.ok) return ""
    const user = await res.json()
    return user.email || user.sub || ""
  } catch {
    return ""
  }
}

// 一次性登录会话。key = AbortSignal 对象，回调完成/取消后清理。
const pending = new Map()

/** 在 62345-62364 之间起一个本地回调 server。 */
async function startCallbackServer() {
  let resolveCallback
  let rejectCallback
  const callback = new Promise((resolve, reject) => {
    resolveCallback = resolve
    rejectCallback = reject
  })

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    const code = url.searchParams.get("code")
    const state = url.searchParams.get("state")
    const error = url.searchParams.get("error") ?? url.searchParams.get("error_description")
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    if (error) {
      res.end("<html><body><h1>登录失败</h1><p>可以关闭此窗口。</p></body></html>")
      rejectCallback(new Error(`OAuth error: ${error}`))
      return
    }
    if (code && state) {
      res.end("<html><body><h1>登录成功</h1><p>可以关闭此窗口，回到 magpie。</p></body></html>")
      resolveCallback({ code, state })
      return
    }
    res.writeHead(404)
    res.end()
  })

  const port = await new Promise((resolve, reject) => {
    let current = OAUTH.callbackPortStart
    const tryPort = () => {
      if (current > OAUTH.callbackPortEnd) {
        reject(new Error(`no free callback port in ${OAUTH.callbackPortStart}-${OAUTH.callbackPortEnd}`))
        return
      }
      server.once("error", () => { current++; tryPort() })
      server.listen(current, "localhost", () => resolve(current))
    }
    tryPort()
  })

  return { server, port, callback, done: { resolve: resolveCallback, reject: rejectCallback } }
}

/** magpie type:"oauth" 的 authorize：开始浏览器 PKCE 登录。 */
export async function startPkceLogin() {
  const { codeVerifier, codeChallenge } = generatePKCE()
  const state = randomBytes(16).toString("hex")
  const { server, port, callback, done } = await startCallbackServer()
  const redirectUri = `http://localhost:${port}`

  return {
    url: buildAuthUrl({ callbackPort: port, codeChallenge, state }),
    instructions: "在浏览器完成 JetBrains 登录；完成后回到 magpie。",
    method: "auto",
    callback: async ({ signal } = {}) => {
      try {
        const { code, state: gotState } = await Promise.race([
          callback,
          new Promise((_, reject) => {
            if (signal?.aborted) reject(new Error("aborted"))
            else signal?.addEventListener?.("abort", () => reject(new Error("aborted")), { once: true })
          }),
        ])
        if (gotState !== state) throw new Error("OAuth state mismatch")
        const t = await exchangeToken({
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri,
        })
        const accountId = await resolveAccountId(t.access_token)
        return {
          type: "success",
          // 上游 Bearer 用 id_token（与 CLI 一致）
          access: t.id_token ?? t.access_token,
          accessToken: t.access_token,
          idToken: t.id_token,
          refresh: t.refresh_token,
          expires: t.expires_in ? Date.now() + t.expires_in * 1000 : 0,
          accountId,
          metadata: { source: "browser-pkce", freeGoogleApi: true, license: "free", email: accountId },
        }
      } catch (err) {
        return { type: "failed", error: String(err?.message ?? err).slice(0, 500) }
      } finally {
        server.close()
      }
    },
    // 供 signal 取消时调用（由 index.mjs 在 authorize 返回后挂到 signal 上）
    _cleanup() {
      server.close()
      done.reject(new Error("cancelled"))
    },
  }
}

/**
 * 直接用 refresh token 换取完整账号（登录方法「Refresh token」用）。
 * refresh token 来自 JetBrains CLI/OAuth，形如 oW66… / fHx… / 8Sl…。
 */
export async function signInWithRefreshToken(refresh) {
  const token = String(refresh ?? "").trim()
  if (!token) throw new Error("refresh token 不能为空")
  const t = await exchangeToken({ grant_type: "refresh_token", refresh_token: token })
  const access = t.id_token ?? t.access_token
  if (!access) throw new Error("上游没有返回 access/id token")
  const accountId = await resolveAccountId(t.access_token ?? access)
  return {
    type: "success",
    key: access,
    access,
    accessToken: t.access_token,
    idToken: t.id_token,
    refresh: t.refresh_token ?? token,
    expires: t.expires_in ? Date.now() + t.expires_in * 1000 : 0,
    accountId,
    metadata: { source: "refresh-token", license: "free", email: accountId, freeGoogleApi: true },
  }
}

export const _internal = {
  generatePKCE,
  buildAuthUrl,
  exchangeToken,
  refreshAccessToken,
  resolveAccountId,
  startCallbackServer,
  signInWithRefreshToken,
  pending,
}
