// 真机验证：refresh + PKCE URL 构造（不打印 token）
import { readCliCredentials } from "../lib/credentials.mjs"
import { refreshAccessToken, generatePKCE, buildAuthUrl } from "../lib/auth.mjs"
const r = await readCliCredentials()
if (!r.ok) { console.log("no creds:", r.reason); process.exit(1) }
try {
  const next = await refreshAccessToken(r.auth)
  console.log("REFRESH OK")
  console.log("  new access len:", next.access.length, "rotated:", next.access !== r.auth.access)
  console.log("  expires:", new Date(next.expires).toISOString())
} catch (e) { console.log("REFRESH FAIL:", e.message, e.signIn ?? "") }
const { codeVerifier, codeChallenge } = generatePKCE()
console.log("PKCE verifier/challenge lens:", codeVerifier.length, codeChallenge.length)
const url = buildAuthUrl({ callbackPort: 62345, codeChallenge, state: "abc123" })
console.log("PKCE URL:", url.slice(0, 160) + "...")
