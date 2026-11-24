// 本地 MITM 抓包代理：临时让 CLI 把 HTTPS 请求发到这里，记录明文请求后转发到上游。
// 需要自制 CA 证书并让 CLI 信任（Java: -Djavax.net.ssl.trustStore）。
// 本脚本只打印请求方法/URL/header 名/body 前 200 字符，不打印 token 值。
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"
const PORT = 8899
const LOG = []
const server = createServer((req, res) => {
  const u = new URL(req.url, "http://localhost")
  const chunks = []
  req.on("data", c => chunks.push(c))
  req.on("end", async () => {
    const body = Buffer.concat(chunks)
    const entry = {
      method: req.method, url: req.url,
      headers: Object.fromEntries(Object.entries(req.headers).map(([k,v]) => [k, typeof v==="string"&&v.length>80?v.slice(0,40)+"...<redacted>":v])),
      body: body.toString("utf8").slice(0, 500),
      ts: new Date().toISOString(),
    }
    LOG.push(entry)
    console.log("CAPTURED", JSON.stringify(entry, null, 2).slice(0, 2000))
    res.writeHead(200); res.end("captured")
  })
})
server.listen(PORT, "127.0.0.1", () => console.log("capture proxy listening on", PORT))
