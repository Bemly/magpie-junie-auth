// PKCE / OAuth 表单的纯函数测试
import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { generatePKCE, buildAuthUrl, refreshAccessToken } from "../lib/auth.mjs"

test("generatePKCE: verifier/challenge length + sha256 relation", () => {
  const { codeVerifier, codeChallenge } = generatePKCE()
  assert.equal(codeVerifier.length, 43)
  assert.equal(codeChallenge, createHash("sha256").update(codeVerifier).digest("base64url"))
  assert.notEqual(generatePKCE().codeVerifier, codeVerifier)
})

test("buildAuthUrl matches Junie CLI format (%20 scope, full params)", () => {
  const url = buildAuthUrl({ callbackPort: 62345, codeChallenge: "CH", state: "ST" })
  assert.equal(url, "https://junie.jetbrains.com/cli-auth?client_id=junie-cli&scope=offline_access%20openid%20jb-authn-service&state=ST&code_challenge=CH&redirect_uri=http%3A%2F%2Flocalhost%3A62345")
})

import { setFetchImpl, clearFetchImpl } from "../lib/proxy.mjs"

test("refreshAccessToken maps invalid_grant to signIn expired", async () => {
  setFetchImpl(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }))
  try {
    await assert.rejects(
      () => refreshAccessToken({ type: "oauth", refresh: "R" }),
      (err) => err.signIn === "expired",
    )
  } finally { clearFetchImpl() }
})

test("refreshAccessToken keeps key in sync with access", async () => {
  setFetchImpl(async () => new Response(JSON.stringify({
    id_token: "new-access", access_token: "at", refresh_token: "new-refresh", expires_in: 3600,
  })))
  try {
    const r = await refreshAccessToken({ type: "oauth", access: "old", key: "old", refresh: "R" })
    assert.equal(r.key, "new-access")
    assert.equal(r.access, "new-access")
    assert.equal(r.refresh, "new-refresh")
  } finally { clearFetchImpl() }
})
