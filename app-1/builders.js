// ============================================================
// Provider capability helpers + request body builders.
// Pure functions; depend only on TOOLS_* globals from tools.js.
// Browser and Node tests both load this file directly.
// ============================================================

function isReasoningModel(model) {
  // OpenAI models that accept `reasoning_effort` (and forbid `temperature` when effort > none).
  return /^o[1-9]/.test(model) || /^gpt-5/.test(model);
}

function mustThink(provider, model) {
  // Models that cannot have thinking turned off — the toggle is forced on for these.
  if (provider === "openai") return /^o[1-9]/.test(model);            // o-series: no reasoning_effort:"none"
  if (provider === "anthropic") return /^claude-mythos/.test(model);  // Mythos rejects type:"disabled"
  if (provider === "gemini") return /^gemini-3\.1-pro/.test(model) || /^gemini-3-deep-think/.test(model);
  return false;
}

function effectiveThinking(provider, cfg) {
  return mustThink(provider, cfg.model) || cfg.thinkingEnabled !== false;
}

function anthropicUsesAdaptive(model) {
  // Models where `thinking.type: "adaptive"` is required (opus-4-7) or preferred (opus-4-6, sonnet-4-6).
  return /^(claude-opus-4-7|claude-opus-4-6|claude-sonnet-4-6|claude-mythos)/.test(model);
}

function anthropicBudget(effort) {
  // Maps effort → budget_tokens for `thinking.type: "enabled"` (haiku-4-5 and older).
  return ({ low: 1024, medium: 4096, high: 8192, xhigh: 12000, max: 14000 })[effort] || 8192;
}

function geminiUses3x(model) {
  return /^gemini-3/.test(model);
}

function geminiLevel(effort) {
  // Gemini 3.x `thinkingLevel` caps at "high"; maps xhigh/max down.
  return ({ low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" })[effort] || "high";
}

function geminiBudget(effort) {
  // Gemini 2.5 `thinkingBudget` in tokens; -1 = dynamic (near-max).
  return ({ low: 2048, medium: 8192, high: 16384, xhigh: -1, max: -1 })[effort] ?? 16384;
}

// ---- Body builders ----
// includeTools (default true) attaches provider-specific tool schemas from tools.js.

function buildOpenAIBody(provider, cfg, messages, stream, includeTools = true) {
  const body = { model: cfg.model, messages };
  if (stream) body.stream = true;
  const thinking = effectiveThinking(provider, cfg);
  if (provider === "deepseek") {
    if (thinking) {
      body.thinking = { type: "enabled" };
      body.reasoning_effort = cfg.reasoningEffort || "max";
    }
    body.temperature = 0.3;
    if (includeTools) {
      body.tools = TOOLS_OPENAI;
      body.tool_choice = "auto";
    }
    return body;
  }
  body.max_completion_tokens = 16384;
  const effort = cfg.reasoningEffort || "high";
  if (thinking && isReasoningModel(cfg.model) && effort !== "none") {
    // gpt-5.x / o-series: reasoning_effort > none forbids temperature/top_p/logprobs.
    body.reasoning_effort = effort === "max" ? "xhigh" : effort;
  } else {
    if (thinking === false && isReasoningModel(cfg.model)) body.reasoning_effort = "none";
    body.temperature = 0.3;
  }
  if (includeTools) {
    body.tools = TOOLS_OPENAI;
    body.tool_choice = "auto";
  }
  return body;
}

function buildAnthropicBody(cfg, systemPrompt, messages, stream, includeTools = true) {
  const effort = cfg.reasoningEffort || "high";
  const thinking = effectiveThinking("anthropic", cfg);
  const body = { model: cfg.model, system: systemPrompt, messages, max_tokens: 16384 };
  if (stream) body.stream = true;
  if (!thinking) {
    body.thinking = { type: "disabled" };
    body.temperature = 0.3;
  } else if (anthropicUsesAdaptive(cfg.model)) {
    body.thinking = { type: "adaptive" };
    body.output_config = { effort };
  } else {
    body.thinking = { type: "enabled", budget_tokens: anthropicBudget(effort) };
  }
  // temperature/top_p/top_k must be left at defaults when thinking is active — omit them.
  if (includeTools) body.tools = TOOLS_ANTHROPIC;
  return body;
}

function buildGeminiBody(cfg, systemPrompt, contents, includeTools = true) {
  const effort = cfg.reasoningEffort || "high";
  const thinking = effectiveThinking("gemini", cfg);
  const generationConfig = { maxOutputTokens: 16384 };
  if (thinking) {
    const thinkingConfig = { includeThoughts: true };
    if (geminiUses3x(cfg.model)) thinkingConfig.thinkingLevel = geminiLevel(effort);
    else thinkingConfig.thinkingBudget = geminiBudget(effort);
    generationConfig.thinkingConfig = thinkingConfig;
    // temperature omitted for parity with OpenAI/Anthropic reasoning paths (both forbid it when thinking is on).
  } else {
    // 2.5: budget 0 disables; 3.x: minimum level (some 3.x variants can't fully disable).
    generationConfig.thinkingConfig = geminiUses3x(cfg.model)
      ? { thinkingLevel: "minimal", includeThoughts: false }
      : { thinkingBudget: 0, includeThoughts: false };
    generationConfig.temperature = 0.3;
  }
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig
  };
  if (includeTools) body.tools = TOOLS_GEMINI;
  return body;
}
