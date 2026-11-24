// Junie CLI 自动版本维护（仅桥接模式用）。
//
// 背景：Junie 上游会提高 junie-lite free 模型的最低 CLI 版本要求；旧版本会返回
// "Your version of Junie doesn't support this free model, please update it first"。
// 插件在加载时每隔 N 小时检查一次 CLI 版本，发现新版就调 `junie update` 自动升级。
//
// 关键事实（实测 2026-11-24）：
//   - `junie update` 幂等：已是最新会说 "already up to date"。
//   - CLI 的 readPipedInput() 在 stdin 是 pipe 时会抛 "函数不正确"；必须给真实文件 fd。
//   - 残留的 `updates/*.download` 文件会让更新报 "Another Junie instance is already
//     downloading this update"；检查前先清理超时（>1h）的半成品。
//   - 更新成功后 CLI 自动把 `~/.local/share/junie/current` 切到新版本目录。
//
// 节流状态写在 magpie 配置目录下 `junie-update-check.json`，默认 6 小时。

import { spawn } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000
const STALE_DOWNLOAD_MS = 60 * 60 * 1000

/** CLI 根目录（可通过 JUNIE_DATA 覆盖，与 junie.bat 一致） */
export function junieDataDir() {
  return process.env.JUNIE_DATA ?? join(homedir(), ".local", "share", "junie")
}

/** 当前版本（读 current 文件） */
export function currentVersion(dataDir = junieDataDir()) {
  try { return readFileSync(join(dataDir, "current"), "utf8").trim() } catch { return "" }
}

/** 节流状态文件路径 */
function statePath(directory) {
  const base = directory ?? join(homedir(), ".config", "magpie")
  return join(base, "junie-update-check.json")
}

function readState(directory) {
  try { return JSON.parse(readFileSync(statePath(directory), "utf8")) } catch { return {} }
}

function writeState(directory, state) {
  try {
    const p = statePath(directory)
    mkdirSync(join(p, ".."), { recursive: true })
    writeFileSync(p, JSON.stringify(state), "utf8")
  } catch { /* 状态写不进去不影响功能 */ }
}

/** 清理超时的半成品下载文件（>1h），避免阻塞更新 */
export function cleanStaleDownloads(dataDir = junieDataDir(), now = Date.now()) {
  const dir = join(dataDir, "updates")
  let removed = []
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".download")) continue
      const p = join(dir, f)
      try {
        if (now - statSync(p).mtimeMs > STALE_DOWNLOAD_MS) { rmSync(p, { force: true }); removed.push(f) }
      } catch { /* 文件可能刚被删 */ }
    }
  } catch { /* updates 目录不存在 */ }
  return removed
}

/** 同步跑 `junie update < real-file-stdin`，返回 { ok, output } */
const DEFAULT_JUNIE = process.platform === "win32"
  ? join(homedir(), ".local", "bin", "junie.bat")
  : join(homedir(), ".local", "bin", "junie")

export function runUpdate({ bin = DEFAULT_JUNIE, timeoutMs = 300_000 } = {}) {
  return new Promise((resolve) => {
    const p = join(tmpdir(), `junie-update-stdin-${Date.now()}.txt`)
    try { writeFileSync(p, "\n", "utf8") } catch (err) { return resolve({ ok: false, output: String(err) }) }
    let fd
    try { fd = openSync(p, "r") } catch (err) { rmSync(p, { force: true }); return resolve({ ok: false, output: String(err) }) }
    const isWindows = process.platform === "win32"
    const cmd = isWindows ? "cmd.exe" : bin
    const args = isWindows ? ["/c", bin, "update"] : ["update"]
    const child = spawn(cmd, args, { windowsHide: true, stdio: [fd, "pipe", "pipe"] })
    closeSync(fd)
    let output = "", done = false
    const timer = setTimeout(() => child.kill(), timeoutMs)
    const finish = (ok, extra = "") => {
      if (done) return
      done = true
      clearTimeout(timer)
      rmSync(p, { force: true })
      resolve({ ok, output: output + extra })
    }
    child.stdout?.on("data", (c) => { output += c })
    child.stderr?.on("data", (c) => { output += c })
    child.on("error", (err) => finish(false, String(err)))
    child.on("close", (code) => finish(code === 0, output))
  })
}

/**
 * 检查并按需更新 CLI。
 * @returns {Promise<{checked:boolean, updated:boolean, version:string, output:string, reason?:string}>}
 */
export async function checkAndUpdate({
  bin,
  directory,
  intervalMs = DEFAULT_INTERVAL_MS,
  now = Date.now(),
  dataDir = junieDataDir(),
  force = false,
} = {}) {
  const state = readState(directory)
  if (!force && state.lastCheck && now - state.lastCheck < intervalMs) {
    return { checked: false, updated: false, version: currentVersion(dataDir), output: "", reason: "throttled" }
  }
  writeState(directory, { ...state, lastCheck: now })
  const before = currentVersion(dataDir)
  const removed = cleanStaleDownloads(dataDir, now)
  const { ok, output } = await runUpdate({ bin })
  const after = currentVersion(dataDir)
  const updated = after !== before
  writeState(directory, { lastCheck: now, lastVersion: after, lastResult: ok ? "ok" : "failed", removedStale: removed })
  return {
    checked: true,
    updated,
    version: after,
    output: (removed.length ? `removed stale: ${removed.join(",")}\n` : "") + output,
    reason: ok ? (updated ? "updated" : "up-to-date") : "update-failed",
  }
}

export const _internal = { DEFAULT_INTERVAL_MS, statePath, readState, writeState, cleanStaleDownloads }
