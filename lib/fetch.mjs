// loader 的 fetch：把 magpie 的标准请求转发到 Junie 上游。
//
// 关键事实：
// - 上游 Anthropic /v1/messages、OpenAI /v1/chat/completions 原生直通（junie-api MITM），
//   这里只做鉴权头注入 + 字段白名单清理 + model id 映射，SSE 原样透传。
// - X-Free-Google-Api: true 是免费 Google 档；上游 477 时去掉该头重试一次。
// - 本机直连中国 IP 会被 403（见规划 §0.5），需要 Node 24 的 NODE_USE_ENV_PROXY=1
//   或宿主已配置代理；这里不强行改全局 fetch，由宿主/启动参数解决。

import {
  UPSTREAM, DEFAULT_GRAZIE_AGENT, ANTHROPIC_FIELDS, OPENAI_FIELDS,
  sanitizePayload, passthroughHeaders, resolveOpenAIModelId,
  isAnthropicModel, isOpenAIModel,
} from "./constants.mjs"
import { routeOf } from "./models.mjs"
import { proxyFetch } from "./proxy.mjs"

/** 从 JSON body 里取 model id（容错）。 */
export function bodyModel(body) {
  try {
    const s = typeof body === "string" ? body : new TextDecoder().decode(body)
    return JSON.parse(s)?.model
  } catch {
    return undefined
  }
}

/** 改写 JSON body（保持字符串/字节形态与输入一致）。 */
function rewriteBody(body, mutate) {
  if (!body) return body
  const isString = typeof body === "string"
  const text = isString ? body : new TextDecoder().decode(body)
  let obj
  try { obj = JSON.parse(text) } catch { return body }
  const next = mutate(obj)
  const out = JSON.stringify(next)
  return isString ? out : new TextEncoder().encode(out)
}

/** 构造上游 URL（magpie 传进来的 input 是基地址+路径，这里按模型族覆盖路径）。 */
export function upstreamUrl(input, route, options) {
  const u = new URL(String(input))
  const path = route === "anthropic" ? UPSTREAM.anthropicMessagesPath
    : route === "openai" ? UPSTREAM.openaiChatPath
      : route === "vllm" ? UPSTREAM.vllmChatPath
        : u.pathname
  u.pathname = path
  if (options?.grazieProxyHost) u.host = options.grazieProxyHost
  return u.toString()
}

/** 许可证/免费额度错误判定：上游 JSON 明确说没订阅时，用户能看懂。 */
function noteError(res, text) {
  if (res.status === 401 || res.status === 403) {
    // 403 HTML 常见于地域封锁；不要吞掉原文，_DEBUG 由宿主处理
  }
  return text
}

/**
 * 生成 loader 用的 fetch。
 * @param auth 已登录账号（{type:"oauth"|"api", access|key, metadata}）
 * @param options 插件选项（freeGoogleApi / grazieAgentVersion / grazieProxyHost）
 */
export function makeFetch(auth, options = {}) {
  const token = auth?.access ?? auth?.key
  const license = options.license ?? auth?.metadata?.license ?? "free"
  const grazieAgent = options.grazieAgentVersion
    ? `{"name":"junie:cli","version":"${options.grazieAgentVersion}"}`
    : DEFAULT_GRAZIE_AGENT
  let freeGoogleApi = options.freeGoogleApi !== false && auth?.metadata?.freeGoogleApi !== false

  return async function junieFetch(input, init = {}) {
    const model = bodyModel(init.body)
    const route = routeOf(model)
    const url = upstreamUrl(input, route, options)
    const kind = isAnthropicModel(model) ? "anthropic" : isOpenAIModel(model) ? "openai" : "anthropic"
    const headers = new Headers({
      ...passthroughHeaders(token, { kind, freeGoogleApi, grazieAgent, license }),
      ...Object.fromEntries(new Headers(init.headers)),
    })
    // authorization 必须以 Junie token 为准，覆盖 magpie/AI SDK 从 apiKey 生成的头
    headers.set("Authorization", `Bearer ${token}`)

    let body = init.body
    if (route === "anthropic") {
      body = rewriteBody(body, (o) => sanitizePayload(o, ANTHROPIC_FIELDS))
    } else if (route === "openai" || route === "vllm") {
      body = rewriteBody(body, (o) => {
        const safe = sanitizePayload(o, OPENAI_FIELDS)
        if (safe.model) safe.model = resolveOpenAIModelId(safe.model)
        return safe
      })
    }

    const send = (withFree) => {
      const h = new Headers(headers)
      if (withFree) h.set("X-Free-Google-Api", "true")
      else h.delete("X-Free-Google-Api")
      // 用 proxyFetch —— loader 返回的 fetch 会替换宿主同名引用，
      // 直接写 fetch() 会递归调用自己（amd-cloud 插件踩过的坑）
      return proxyFetch(url, { ...init, headers: h, body }, { proxy: options.proxy })
    }

    const first = await send(freeGoogleApi)
    if (first.status === 477 && freeGoogleApi) {
      freeGoogleApi = false
      if (auth?.metadata) auth.metadata.freeGoogleApi = false
      return send(false)
    }
    return first
  }
}

export const _internal = { bodyModel, rewriteBody, upstreamUrl, makeFetch }
