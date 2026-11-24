// 模型表：junie-api v0.3.1 的 KNOWN_MODELS（2026-03/04 抓包）。
// 注意：本机 CLI 4100.11 实际用 Qwen/Qwen3.6-27B-FP8（见规划 §0.5），
// 旧 id 可能已失效——M1 真机探测后更新。此处保留 junie-api 快照作为基线。

export const MODELS = {
  "claude-sonnet-4-6": {
    name: "Claude Sonnet 4.6",
    limit: { context: 200000, output: 32000 },
    tool_call: true,
    _route: "anthropic",
  },
  "claude-opus-4-6": {
    name: "Claude Opus 4.6",
    limit: { context: 200000, output: 32000 },
    tool_call: true,
    _route: "anthropic",
  },
  "openai-gpt4.1": {
    name: "OpenAI GPT-4.1",
    limit: { context: 1047576, output: 32768 },
    tool_call: true,
    _route: "openai",
  },
  "openai-gpt4.1-mini": {
    name: "OpenAI GPT-4.1 Mini",
    limit: { context: 1047576, output: 32768 },
    tool_call: true,
    _route: "openai",
  },
  "openai-gpt-4o": {
    name: "OpenAI GPT-4o",
    limit: { context: 128000, output: 16384 },
    tool_call: true,
    _route: "openai",
  },
  "google-chat-gemini-pro-2.5": {
    name: "Gemini 2.5 Pro",
    limit: { context: 1048576, output: 65536 },
    tool_call: true,
    _route: "grazie",
  },
  "google-chat-gemini-flash-2.5": {
    name: "Gemini 2.5 Flash",
    limit: { context: 1048576, output: 65536 },
    tool_call: true,
    _route: "grazie",
  },
  // 本机 CLI 4100.11 实际观测到的模型（Qwen 免费档）
  "Qwen/Qwen3.6-27B-FP8": {
    name: "Qwen3.6 27B (Junie CLI)",
    limit: { context: 131072, output: 16384 },
    tool_call: true,
    _route: "vllm",
  },
}

/** config hook 用的模型表：把内部 _route 字段去掉，按 npm 包分两组声明。 */
export function configModels(options = {}) {
  const out = {}
  for (const [id, m] of Object.entries(MODELS)) {
    if (m._route === "grazie" && options.passthroughOnly !== false) continue
    const { _route, ...rest } = m
    out[id] = rest
  }
  return out
}

/** 按模型 id 决定走哪条上游路径。 */
export function routeOf(modelId) {
  return MODELS[modelId]?._route
    ?? (modelId?.startsWith("claude-") ? "anthropic"
      : modelId?.startsWith("openai-") ? "openai"
        : modelId?.startsWith("google-") ? "grazie" : "vllm")
}

export const _internal = { MODELS, configModels, routeOf }
