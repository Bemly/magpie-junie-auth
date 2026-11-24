// 代理选择：Junie 上游对中国 IP 直连 403，必须走代理。
//
// 与 magpie-capy/src/http.mjs 同款结论：
// - Bun fetch 支持原生 proxy 选项；magpie 宿主包装 globalThis.fetch，Bun.fetch 是原生引用。
// - Node 24+ 可用 NODE_USE_ENV_PROXY=1；这里只对原生 Bun.fetch 显式传 proxy，
//   对 Node/host fetch 不传（交给宿主环境处理）。
//
// 选项来源：插件 options.proxy > JUNIE_REQUEST_PROXY > magpie 代理变量 > 系统代理变量。

/** 从环境变量推断代理服务器 URL；无代理返回 undefined，显式关代理返回 false。 */
export function systemProxy() {
  const pick = () => {
    for (const key of [
      "JUNIE_REQUEST_PROXY",
      "MAGPIE_HTTPS_PROXY", "MAGPIE_HTTP_PROXY", "MAGPIE_ALL_PROXY",
      "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
      "ALL_PROXY", "all_proxy",
    ]) {
      const v = process.env?.[key]
      if (v && v !== "off") return v
      if (v === "off") return false
    }
    return undefined
  }
  return pick()
}

// 可注入的底层 fetch。测试里替换为 mock，此时完全接管（连原生 Bun.fetch 都不用）；
// 生产保持默认包装。注意不能直接用 globalThis.fetch——loader 返回的 fetch 会覆盖
// 宿主的同名引用，导致递归调用自己（amd-cloud 插件踩过的坑）。
let injectedFetch = null
const defaultFetch = (...args) => globalThis.fetch(...args)
export function setFetchImpl(fn) { injectedFetch = fn }
export function clearFetchImpl() { injectedFetch = null }

/**
 * 真正发请求：注入的 mock 优先；否则原生 Bun.fetch 显式带 proxy 选项；再否则宿主 fetch。
 */
let warnedNodeProxy = false

export async function proxyFetch(url, init, { proxy } = {}) {
  if (injectedFetch) return injectedFetch(url, init)
  const wantProxy = proxy ?? systemProxy()
  const bunFetch = globalThis.Bun?.fetch
  if (bunFetch && wantProxy && wantProxy !== false) {
    return bunFetch(url, { ...init, proxy: wantProxy === "auto" ? undefined : wantProxy })
  }
  // Node 的 fetch 默认不读代理 env。若系统有代理但没开 NODE_USE_ENV_PROXY，
  // 上游会静默返回 403 HTML——提示一次，别让人摸不着头脑。
  if (!warnedNodeProxy && !bunFetch && wantProxy && wantProxy !== false
      && !globalThis[Symbol.for("undici.globalDispatcher.1")]) {
    warnedNodeProxy = true
    console.warn("[magpie-junie] Node fetch 未走系统代理；上游可能返回 403。请用 NODE_USE_ENV_PROXY=1 启动，或在 magpie（Bun）里运行。")
  }
  return defaultFetch(url, init)
}

export const _internal = { systemProxy, proxyFetch, setFetchImpl, clearFetchImpl }
