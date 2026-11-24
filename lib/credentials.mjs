// 复用本机 Junie CLI 的登录态。
//
// 凭据位置：~/.junie/dpapi_credentials/*.dpapi
// 文件内容 = DPAPI blob 的 base64 文本；解密（CryptUnprotectData CurrentUser）后是 JSON：
//   { jbAccount: { access_token, refresh_token, expires_in: 3600, name, email, id_token } }
//
// 文件名是哈希，不依赖命名规则：遍历全部 .dpapi，逐个解密，取含 jbAccount 的。
// DPAPI 用 PowerShell 子进程（Windows 自带），与 magpie-capy/src/creds.mjs 同款做法；
// Node/Bun 没有原生绑定。密钥/token 只在内存流转，绝不写日志。

import { execFile } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export const JUNIE_HOME = join(homedir(), ".junie")
export const CREDENTIALS_DIR = join(JUNIE_HOME, "dpapi_credentials")

/** DPAPI 解一块字节，返回明文 Buffer。 */
export async function dpapiUnprotect(bytes) {
  const b64 = Buffer.from(bytes).toString("base64")
  const script = [
    "Add-Type -AssemblyName System.Security | Out-Null",
    `$b = [Convert]::FromBase64String('${b64}')`,
    "$p = [Security.Cryptography.ProtectedData]::Unprotect($b, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Convert]::ToBase64String($p)",
  ].join("; ")
  const { stdout } = await execFileAsync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: 15000, windowsHide: true },
  )
  return Buffer.from(stdout.trim(), "base64")
}

/** JWT exp（秒）→ 毫秒时间戳；非 JWT 或无 exp 返回 null。 */
export function jwtExpiresAt(token) {
  try {
    const parts = token.split(".")
    if (parts.length !== 3) return null
    let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/")
    while (payload.length % 4) payload += "="
    const claims = JSON.parse(Buffer.from(payload, "base64").toString("utf8"))
    return typeof claims.exp === "number" ? claims.exp * 1000 : null
  } catch {
    return null
  }
}

/**
 * macOS：从 Keychain 读 Junie CLI 登录态。
 * account 形如 <sha256(junieHome)><key>，key = "jb-account-stored"；不自己算 hash，
 * 直接列举 service=junie-cli 的条目，取以 jb-account-stored 结尾的 account。
 * 值是 "junie.b64:<base64(json)>"，json = {jbAccount:{access_token,refresh_token,id_token,email,...}}。
 */
export async function readMacKeychainCredentials() {
  try {
    const { stdout: listing } = await execFileAsync(
      "security", ["find-generic-password", "-s", "junie-cli"], { timeout: 15000 },
    )
    const accts = [...String(listing).matchAll(/"acct"<blob>="([^"]+)"/g)].map((m) => m[1])
    const acct = accts.find((a) => a.endsWith("jb-account-stored"))
    if (!acct) return { ok: false, reason: "keychain-no-account" }
    const { stdout } = await execFileAsync(
      "security", ["find-generic-password", "-s", "junie-cli", "-a", acct, "-w"], { timeout: 15000 },
    )
    let val = String(stdout).trim()
    if (val.startsWith("junie.b64:")) val = Buffer.from(val.slice("junie.b64:".length), "base64").toString("utf8")
    const a = JSON.parse(val)?.jbAccount
    if (!a?.access_token) return { ok: false, reason: "keychain-no-token" }
    return {
      ok: true,
      auth: {
        type: "oauth",
        // CLI 发给 Ingrazzio 的 Bearer 实际是 id_token（JbaService.getIdToken()）。
        access: a.id_token ?? a.access_token,
        accessToken: a.access_token,
        idToken: a.id_token,
        refresh: a.refresh_token,
        expires: jwtExpiresAt(a.id_token ?? a.access_token) ?? (a.expires_in ? Date.now() + a.expires_in * 1000 : 0),
        accountId: a.email || a.name || "",
        email: a.email,
        name: a.name,
        metadata: { source: "junie-cli-keychain", freeGoogleApi: true, license: "free" },
      },
    }
  } catch (err) {
    return { ok: false, reason: `keychain-failed: ${err?.message ?? err}` }
  }
}

/**
 * 读取 CLI 登录态。
 * @returns {Promise<{ok:true, auth:{type:"oauth", access, refresh, expires, accountId, email, name}}
 *                  |{ok:false, reason:string}>}>}
 */
export async function readCliCredentials({ credentialsDir = CREDENTIALS_DIR } = {}) {
  // macOS/Linux：凭据在 Keychain/libsecret，不是 Windows 的 DPAPI 文件。
  if (process.platform !== "win32") return readMacKeychainCredentials()
  if (!existsSync(credentialsDir)) return { ok: false, reason: "cli-not-installed" }
  let files
  try {
    files = readdirSync(credentialsDir).filter((f) => f.endsWith(".dpapi"))
  } catch (err) {
    return { ok: false, reason: `read-dir-failed: ${err?.message ?? err}` }
  }
  if (!files.length) return { ok: false, reason: "no-credentials" }

  const errors = []
  for (const file of files) {
    try {
      const text = readFileSync(join(credentialsDir, file), "utf8").trim()
      const blob = Buffer.from(text, "base64")
      const plain = await dpapiUnprotect(blob)
      const obj = JSON.parse(plain.toString("utf8"))
      const acct = obj?.jbAccount
      if (!acct?.access_token) continue
      return {
        ok: true,
        auth: {
          type: "oauth",
          // 注意：CLI 发给 Ingrazzio 的 Bearer token 实际是 id_token（JbaService.getIdToken()），
          // 不是 access_token。access_token 只用于 OAuth userinfo。free tier 必须用 id_token。
          // 两个都存：access=id_token（请求用），accessToken=原 access_token（userinfo 用）。
          access: acct.id_token ?? acct.access_token,
          accessToken: acct.access_token,
          idToken: acct.id_token,
          refresh: acct.refresh_token,
          expires: jwtExpiresAt(acct.id_token ?? acct.access_token) ?? (acct.expires_in ? Date.now() + acct.expires_in * 1000 : 0),
          accountId: acct.email || acct.name || "",
          email: acct.email,
          name: acct.name,
          metadata: { source: "junie-cli", freeGoogleApi: true, license: "free" },
        },
      }
    } catch (err) {
      errors.push(`${file}: ${err?.message ?? err}`)
    }
  }
  return { ok: false, reason: `no-usable-account${errors.length ? `: ${errors[0]}` : ""}` }
}

export const _internal = { dpapiUnprotect, jwtExpiresAt, CREDENTIALS_DIR, readMacKeychainCredentials }
