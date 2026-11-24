// magpie-junie：把 JetBrains Junie 接入 magpie 供应商 `junie`。
//
// 四种登录方式（按优先级）：
//   1. 导入本机 CLI 登录态（macOS Keychain / Windows DPAPI）——最快，不用浏览器
//   2. 浏览器 PKCE（Junie CLI 同款）——没有本地 CLI 时用
//   3. API key（perm-*，从 junie.jetbrains.com/cli 获取）
//   4. 直接粘贴 OAuth refresh token（oW66… / fHx… / 8Sl…）——换取并完整保存
//
// 请求链路（两种，由 options.bridgeUrl 选择）：
//   A. 直连上游：loader.fetch 把标准请求发到 ingrazzio-cloud-prod.labs.jb.gg
//      （见 lib/fetch.mjs）。需代理，且账号要有有效订阅；license=NONE 会被 403。
//   B. 本地桥接（推荐给 free tier）：options.bridgeUrl 指向 bridge-server.mjs，
//      后端调 CLI headless 的 junie-lite 通道（见 bridge-server.mjs）。
//
// 注意：上游对中国 IP 直连返回 403，需宿主/Node 开启代理（NODE_USE_ENV_PROXY=1）。

import { PROVIDER, DISPLAY_NAME } from "./lib/constants.mjs"
import { MODELS, configModels } from "./lib/models.mjs"
import { readCliCredentials } from "./lib/credentials.mjs"
import { startPkceLogin, refreshAccessToken, signInWithRefreshToken } from "./lib/auth.mjs"
import { makeFetch } from "./lib/fetch.mjs"
import { makeDirectFetch, DIRECT_MODEL } from "./lib/direct.mjs"
import { usageHook } from "./lib/usage.mjs"
import { proxyFetch } from "./lib/proxy.mjs"

const MAX_CONCURRENCY = 2

/** 把 CLI 凭据或 PKCE 结果规范化成 magpie 的 success 结果。 */
function success(auth) {
  return { type: "success", ...auth }
}

export async function JuniePlugin(input, options = {}) {
  // plugins.json 里该插件项的 options，闭包捕获，所有 hook 共用。
  const pluginOptions = options ?? {}
  return {
    config: async (cfg = {}) => {
      cfg.provider ??= {}
      // 直连和桥接都只暴露 junie-lite（底层 gpt-6-luna，免费额度）。
      // 直连用 Responses 协议；桥接转发给本地 CLI。
      const opts = pluginOptions
      const models = {
        "junie-lite": { name: "Junie Lite (GPT-6 Luna)", limit: { context: 262144, output: 16384 }, tool_call: true },
      }
      cfg.provider[PROVIDER] ??= {
        name: DISPLAY_NAME,
        npm: "@ai-sdk/openai-compatible", // chat completions
        api: opts.bridgeUrl ?? "https://ingrazzio-cloud-prod.labs.jb.gg/v1",
        models,
      }
    },

    auth: {
      provider: PROVIDER,
      maxConcurrency: MAX_CONCURRENCY,
      refreshLead: 90_000,

      methods: [
        {
          // 用 oauth 而非 api：api 方法在 magpie 里只存 {type,key,metadata}，
          // 丢掉 refresh/expires，导致无法自动续期、多账号里一个过期就卡住。
          // oauth 走 plugin.Finish，完整保存 auth 对象。
          type: "oauth",
          label: "从本机 Junie CLI 导入登录态",
          async authorize() {
            // 本地读凭据，无需浏览器；callback 直接给出结果。
            return {
              url: "",
              instructions: "从本机 Junie CLI 读取登录态。",
              method: "auto",
              callback: async () => {
                const r = await readCliCredentials()
                if (!r.ok) return { type: "failed", error: `未找到可用的 Junie CLI 登录态（${r.reason}）。` }
                return {
                  type: "success",
                  key: r.auth.access,
                  access: r.auth.access,
                  accessToken: r.auth.accessToken,
                  idToken: r.auth.idToken,
                  refresh: r.auth.refresh,
                  expires: r.auth.expires,
                  accountId: r.auth.accountId,
                  metadata: {
                    ...(r.auth.metadata ?? {}),
                    email: r.auth.email ?? r.auth.accountId,
                    cliAuth: r.auth,
                  },
                }
              },
            }
          },
        },
        {
          type: "oauth",
          label: "浏览器登录（JetBrains 账号）",
          async authorize() {
            try {
              const r = await startPkceLogin()
              return {
                url: r.url,
                instructions: r.instructions,
                method: r.method,
                callback: r.callback,
              }
            } catch (err) {
              return { type: "failed", error: `无法开始登录：${String(err?.message ?? err).slice(0, 500)}` }
            }
          },
        },
        {
          type: "api",
          label: "Junie API key (perm-*)",
          placeholder: "perm-…",
        },
        {
          // 直接粘贴 OAuth refresh token（oW66… / fHx… / 8Sl…）：
          // prompts + authorize 让宿主标记 keyAsked，magpie 不再额外问 key。
          type: "api",
          label: "Refresh token (oW66… / fHx…)",
          prompts: [
            { type: "password", key: "refresh", message: "Junie refresh token" },
          ],
          async authorize(inputs = {}) {
            try {
              return await signInWithRefreshToken(inputs.refresh)
            } catch (err) {
              return { type: "failed", error: `refresh token 无效或上游拒绝：${String(err?.message ?? err).slice(0, 300)}` }
            }
          },
        },
      ],

      async loader(getAuth, provider) {
        const auth = await getAuth().catch(() => null)
        // options 来自 plugins.json 的该项；magpie 也可能把它挂在 provider.options 上。
        const options = { ...pluginOptions, ...(provider?.options ?? {}) }
        if (options.bridgeUrl) {
          // 本地桥接模式：后端是 CLI headless，它自己持有 Junie 登录态，
          // 所以这里**不要求 magpie 侧登录**，任何账号状态都能转发。
          const base = String(options.bridgeUrl).replace(/\/+$/, "")
          return {
            baseURL: base,
            apiKey: "local",
            fetch: (input, init) => {
              const u = new URL(String(input))
              const target = new URL(base)
              u.protocol = target.protocol
              u.host = target.host
              return proxyFetch(u.toString(), init, { proxy: false })
            },
          }
        }
        // 直连模式：用逆向的 Responses 协议（免费额度可用，无需 CLI 本体）。
        return {
          baseURL: "https://ingrazzio-cloud-prod.labs.jb.gg/v1",
          apiKey: auth.access ?? auth.key,
          fetch: makeDirectFetch(auth, options),
        }
      },

      async refresh(auth) {
        return refreshAccessToken(auth)
      },

      async usage(getAuth) {
        return usageHook(getAuth)
      },
    },

    provider: {
      id: PROVIDER,
      async models(providerModels, { auth } = {}) {
        if (pluginOptions.bridgeUrl) {
          return { "junie-lite": { name: "Junie Lite (CLI)", limit: { context: 262144, output: 16384 }, tool_call: true } }
        }
        // 直连/桥接都只提供 junie-lite（底层 gpt-6-luna），与其他旧模型无关。
        return {
          "junie-lite": { name: "Junie Lite (GPT-6 Luna)", limit: { context: 262144, output: 16384 }, tool_call: true },
        }
      },
    },
  }
}

// 入口纪律：只导出插件函数 + default；辅助函数放 lib/ 和 _internal。
export const _internal = { MODELS, configModels, readCliCredentials, startPkceLogin, makeFetch, usageHook }

export default { id: PROVIDER, server: JuniePlugin }
