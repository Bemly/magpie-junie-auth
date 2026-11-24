import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  currentVersion, cleanStaleDownloads, checkAndUpdate,
  _internal,
} from "../lib/auto-update.mjs"

function tempDataDir() {
  const dir = mkdtempSync(join(tmpdir(), "junie-update-test-"))
  mkdirSync(join(dir, "updates"), { recursive: true })
  return dir
}

test("currentVersion reads current file", () => {
  const dir = tempDataDir()
  writeFileSync(join(dir, "current"), "4171.6\n")
  assert.equal(currentVersion(dir), "4171.6")
})

test("currentVersion returns empty when missing", () => {
  assert.equal(currentVersion(tempDataDir()), "")
})

test("cleanStaleDownloads removes only old .download files", () => {
  const dir = tempDataDir()
  const old = join(dir, "updates", "old.zip.1.download")
  const fresh = join(dir, "updates", "fresh.zip.2.download")
  const done = join(dir, "updates", "done.zip")
  writeFileSync(old, "x")
  writeFileSync(fresh, "x")
  writeFileSync(done, "x")
  const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
  utimesSync(old, longAgo, longAgo)
  const removed = cleanStaleDownloads(dir)
  assert.deepEqual(removed, ["old.zip.1.download"])
  assert.ok(existsSync(fresh))
  assert.ok(existsSync(done))
})

test("checkAndUpdate throttles within interval", async () => {
  const dir = tempDataDir()
  const stateDir = tempDataDir()
  const now = Date.now()
  writeFileSync(join(dir, "current"), "4171.6")
  // 预先写 state：刚检查过
  writeFileSync(_internal.statePath(stateDir), JSON.stringify({ lastCheck: now - 1000 }))
  const r = await checkAndUpdate({
    dataDir: dir,
    directory: stateDir,
    now,
    bin: "nonexistent-for-throttle-test",
  })
  assert.equal(r.checked, false)
  assert.equal(r.reason, "throttled")
  assert.equal(r.version, "4171.6")
})

test("statePath and read/write state roundtrip", () => {
  const dir = tempDataDir()
  const p = _internal.statePath(dir)
  _internal.writeState(dir, { lastCheck: 123, lastVersion: "1.2.3" })
  assert.deepEqual(_internal.readState(dir), { lastCheck: 123, lastVersion: "1.2.3" })
  assert.ok(existsSync(p))
})
