// JWT exp 解析（用 junie-api 同款算法）
import test from "node:test"
import assert from "node:assert/strict"
import { jwtExpiresAt } from "../lib/credentials.mjs"

function jwt(payload) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
  return `${enc({ alg: "none" })}.${enc(payload)}.sig`
}

test("jwtExpiresAt decodes exp", () => {
  const t = Math.floor(Date.now() / 1000) + 3600
  assert.equal(jwtExpiresAt(jwt({ exp: t })), t * 1000)
})

test("jwtExpiresAt handles url-safe base64 and padding", () => {
  const t = 2000000000
  assert.equal(jwtExpiresAt(jwt({ exp: t, sub: "a/b+c=d" })), t * 1000)
})

test("jwtExpiresAt returns null for non-JWT / missing exp", () => {
  assert.equal(jwtExpiresAt("not-a-jwt"), null)
  assert.equal(jwtExpiresAt(jwt({ sub: "x" })), null)
  assert.equal(jwtExpiresAt(jwt({ exp: "soon" })), null)
})
