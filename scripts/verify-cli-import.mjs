// 真机验证：从本机 Junie CLI 导入登录态（不打印 token 本身）
import { readCliCredentials } from "../lib/credentials.mjs"
const r = await readCliCredentials()
if (!r.ok) { console.log("IMPORT FAIL:", r.reason); process.exit(1) }
console.log("IMPORT OK")
console.log("  type:", r.auth.type)
console.log("  accountId:", r.auth.accountId)
console.log("  access len:", r.auth.access.length)
console.log("  refresh len:", r.auth.refresh?.length ?? 0)
console.log("  expires:", new Date(r.auth.expires).toISOString())
console.log("  source:", r.auth.metadata?.source)
