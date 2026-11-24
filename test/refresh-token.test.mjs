// 「Refresh token」登录方法：换取流程与完整 auth 字段。
import test from "node:test"
import assert from "node:assert/strict"
import { signInWithRefreshToken } from "../lib/auth.mjs"
import { setFetchImpl, clearFetchImpl } from "../lib/proxy.mjs"

function jwt(payload) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
  return `${enc({ alg: "none" })}.${enc(payload)}.sig`
}

test("signInWithRefreshToken 换取并保存完整 auth", async () => {
  const idToken = jwt({ email: "someone@example.com", exp: Math.floor(Date.now() / 1000) + 3600 })
  let seen
  setFetchImpl(async (url, init) => {
    if (String(url).includes("userinfo")) {
      return new Response(JSON.stringify({ email: "someone@example.com" }))
    }
    seen = { url, init }
    return new Response(JSON.stringify({
      id_token: idToken,
      access_token: "access-1",
      refresh_token: "refresh-2",
      expires_in: 3600,
    }))
  })
  try {
    const r = await signInWithRefreshToken("  refresh-1  ")
    assert.equal(r.type, "success")
    assert.equal(r.key, idToken)
    assert.equal(r.access, idToken)
    assert.equal(r.refresh, "refresh-2")
    assert.ok(r.expires > Date.now())
    assert.equal(r.metadata.email, "someone@example.com")
    assert.equal(r.metadata.source, "refresh-token")
    assert.match(String(seen.url), /oauth2\/token/)
    const body = new URLSearchParams(seen.init.body)
    assert.equal(body.get("grant_type"), "refresh_token")
    assert.equal(body.get("refresh_token"), "refresh-1")
    assert.equal(body.get("client_id"), "junie-cli")
  } finally {
    clearFetchImpl()
  }
})

test("signInWithRefreshToken 上游拒绝时抛错", async () => {
  setFetchImpl(async () => new Response('{"error":"invalid_grant"}', { status: 400 }))
  try {
    await assert.rejects(() => signInWithRefreshToken("bad"), /token exchange failed/)
  } finally {
    clearFetchImpl()
  }
})
