# Tool-Calling Implementation Plan (v2)

## Context

当前 `sendMessage()` 用 `!this.meeting.segments.length` 判断是否首次解析来选 prompt，非报名文本的首次消息会误触发初始解析。改为让 LLM 通过工具调用决定何时创建/修改 agenda，同时携带对话历史。

**架构**：双轮（router → executor）。第一轮带 tools + SYSTEM_PROMPT 做轻量路由；第二轮内部用 `PLAN_/ADJUST_` prompts 生成 JSON。选双轮的理由：
- 明确测试四家 provider 的工具调用能力（本项目的核心目的之一）
- 预留扩展点 —— 后续会加更细的工具（`swap_role` / `change_duration` / `add_segment` 等），细工具不再调第二轮 LLM 而直接改状态

## Files

- **新建** `app-1/tools.js` — 工具注册表 + 三家 schema adapter
- **修改** `app-1/prompts.js` — 新增 `SYSTEM_PROMPT`，保留旧 prompt 供 executor 用
- **修改** `app-1/chat-agenda.html` — streaming tool_call 累积、body builder 加 tools、sendMessage 重构、消息历史转换、UI 更新

## Key Design — Tool Registry 驱动

```js
// tools.js
const TOOL_REGISTRY = [
  { name: "create_meeting",
    description: "Generate a new meeting agenda from raw registration text the user just pasted.",
    params: { raw_text: { type: "string", description: "Full pasted registration text" } },
    required: ["raw_text"] },
  { name: "adjust_meeting",
    description: "Modify an existing agenda. Requires an agenda to already exist.",
    params: { request: { type: "string", description: "User's modification request verbatim" } },
    required: ["request"] }
  // 将来：swap_role, change_duration, add_segment, remove_segment ...
];

const TOOLS_OPENAI    = TOOL_REGISTRY.map(toOpenAI);
const TOOLS_ANTHROPIC = TOOL_REGISTRY.map(toAnthropic);
const TOOLS_GEMINI    = [{ functionDeclarations: TOOL_REGISTRY.map(toGemini) }];
```

三家 adapter 读 registry 生成对应格式。Gemini 用大写 OpenAPI 类型（`OBJECT` / `STRING`）。加新工具只改 registry + `executeToolCall` dispatch map。

## Corrected API Reference

| | OpenAI/DeepSeek | Anthropic | Gemini |
|---|---|---|---|
| tools schema | `tools: [{type:"function", function:{...}}]` + `tool_choice:"auto"` | `tools: [{name, input_schema}]` | `tools: [{functionDeclarations:[...]}]` |
| SSE tool delta | `delta.tool_calls[]` 按 index 累积 `id` / `function.name` / `function.arguments` | `content_block_start`(tool_use) + `input_json_delta.partial_json` 按 block 累积 | `part.functionCall.{name, args}`，通常整 part 到达 |
| tool_call ID | `delta.tool_calls[].id` | `content_block.id` | **自行生成**（如 `gemini_${Date.now()}`） |
| 检测工具调用完成 | `finish_reason:"tool_calls"` | `content_block_stop` + 非空 tool_use blocks（**不看 stop_reason**，stop_reason 是 `"tool_use"` 但不作为主判据） | 流结束时 parts 中存在 functionCall |
| tool_result 回传 | `{role:"tool", tool_call_id, content: stringified}` | `{role:"user", content:[{type:"tool_result", tool_use_id, content: string}]}` | `{role:"user", parts:[{functionResponse:{name, response: OBJECT}}]}` |
| thinking 保留 | 无要求 | **必须**在 assistant 历史 content 里先放 `{type:"thinking", thinking, signature}` 块再放 `tool_use` 块，否则多轮会 400 | 无要求 |

---

## Phase 1: tools.js + SYSTEM_PROMPT

### Scope
1. 新建 `app-1/tools.js`：`TOOL_REGISTRY` + `toOpenAI` / `toAnthropic` / `toGemini` adapter + 导出 `TOOLS_OPENAI` / `TOOLS_ANTHROPIC` / `TOOLS_GEMINI` 到 window
2. `prompts.js` 新增 `SYSTEM_PROMPT`：

   ```
   You are a Toastmasters meeting planning assistant.

   Tools:
   - create_meeting: call ONLY when the user pastes raw registration text (WeChat format: emojis like 📅⏰, role lines like "TOM: Rui", a date, a theme). Pass the full pasted text as raw_text.
   - adjust_meeting: call ONLY when the user asks to modify an EXISTING agenda (swap roles, change duration, add/remove segments). Pass the user's request verbatim as request.

   Do NOT call any tool when:
   - user chit-chats ("hello", "thanks")
   - user asks a question about the current agenda ("who's taking TOM?", "when does tea break start?")
   - no agenda exists and the message is clearly not registration text

   Reply in plain text for non-tool cases. Keep replies concise.
   ```

3. HTML `<head>` 加 `<script src="tools.js"></script>`，放在 `<script src="prompts.js">` 之后

### Testing (Phase 1)
**Console** — 打开页面后 DevTools Console：
```js
console.assert(Array.isArray(TOOL_REGISTRY) && TOOL_REGISTRY.length >= 2);
console.assert(TOOLS_OPENAI[0].type === 'function' && TOOLS_OPENAI[0].function.name === 'create_meeting');
console.assert(TOOLS_ANTHROPIC[0].name === 'create_meeting' && TOOLS_ANTHROPIC[0].input_schema.type === 'object');
console.assert(TOOLS_GEMINI[0].functionDeclarations[0].name === 'create_meeting');
console.assert(TOOLS_GEMINI[0].functionDeclarations[0].parameters.type === 'OBJECT'); // 大写
console.assert(typeof SYSTEM_PROMPT === 'string' && SYSTEM_PROMPT.includes('create_meeting'));
```
全部无 assertion failed，现有功能（加载 demo、切 provider、Settings）不受影响。

---

## Phase 2: Streaming tool_call 累积 + 返回值扩展

### Scope
1. `callLLMStreaming(systemPrompt, userMessage, onThinking, onContent, signal, opts = {})` 新增 `opts.includeTools` (default true) 和 `opts.history` (default null；若提供则覆盖 `userMessage` 直接用 history)
2. 返回值从 `string` 改为 `{ content, toolCalls, thinkingBlocks }`
   - `toolCalls: [{ id, name, args }]`  — `args` 已 parse 成对象
   - `thinkingBlocks: [{ thinking, signature }]` — 仅 Anthropic 非空，用于历史回传
3. **OpenAI/DeepSeek** `callOpenAIStreaming`: 累积 `delta.tool_calls[i].{id, function.name, function.arguments}`，流结束 `JSON.parse` arguments
4. **Anthropic** `callAnthropicStreaming`: 
   - `content_block_start` 按 block type 分派（`thinking` / `text` / `tool_use`）
   - `content_block_delta`: `thinking_delta.thinking` / `signature_delta.signature` / `input_json_delta.partial_json` / `text_delta.text` 分别累积
   - `content_block_stop` 结束当前 block
   - tool_use.input 累积完后 `JSON.parse(partial_json_accumulated)`
5. **Gemini** `callGeminiStreaming`: 遍历 `parts[]`，若 `part.functionCall` 合并 name/args（按 name 合并）；自行生成 id
6. 所有 caller（目前只有 `sendMessage`）适配新返回结构

### Testing (Phase 2)
**Network** — 打开 DevTools Network 标签：
1. 配置一家 provider 的 key，发 "hello"
2. 找到 `/v1/chat/completions` 或 `/v1/messages` 或 `:streamGenerateContent` 请求
3. Request Payload 检查：
   - OpenAI/DeepSeek: `tools` 数组存在，`tool_choice: "auto"`
   - Anthropic: `tools` 数组存在
   - Gemini: `tools[0].functionDeclarations` 存在

**Console**:
```js
const app = Alpine.$data(document.body);
const ctrl = new AbortController();
const r = await app.callLLMStreaming(SYSTEM_PROMPT, "hello", ()=>{}, ()=>{}, ctrl.signal);
console.log(r);
// Expect: { content: <非空文本>, toolCalls: [], thinkingBlocks: <array> }
```

四家都跑一遍上面的调用，确认返回结构一致、`toolCalls` 均为空数组（"hello" 不该触发工具）。

---

## Phase 3: Body Builder 加 tools

### Scope
1. `buildOpenAIBody(cfg, messages, stream, includeTools)` —  `includeTools=true` 时加 `tools: TOOLS_OPENAI` + `tool_choice: "auto"`
2. `buildAnthropicBody(cfg, systemPrompt, messages, stream, includeTools)` — `includeTools=true` 时加 `tools: TOOLS_ANTHROPIC`
3. `buildGeminiBody(cfg, systemPrompt, contents, includeTools)` — `includeTools=true` 时加 `tools: TOOLS_GEMINI`
4. 三个 streaming 函数把 `opts.includeTools` 透传给 builder

### Testing (Phase 3)
**Network** — 每家 provider 各发一次 "hello"：
- OpenAI/DeepSeek body: `tools: [{type:"function", function:{name:"create_meeting"}}, ...]` + `tool_choice:"auto"`
- Anthropic body: `tools: [{name:"create_meeting", input_schema:{type:"object", properties:{raw_text:...}}}]`
- Gemini body: `tools: [{functionDeclarations:[{name:"create_meeting", parameters:{type:"OBJECT",...}}, ...]}]`

**Toggle 交叉**: thinking off × 四家各发一次，确认 body 仍含 tools；必思考模型（o3 / opus-4-7 / gemini-3.1-pro-preview）下也确认 tools 存在。

---

## Phase 4: 消息历史转换

### Scope

**内部 `messages[]` 条目扩展**:
```js
{ id, role,                  // "info" | "user" | "assistant" | "tool"
  content, thinking,         // 展示用
  thinkingBlocks,            // Array<{thinking, signature}>，Anthropic 历史回传用
  isJson, isToolCall,        // 展示与分派
  toolCallId, toolCallName, toolCallArgs,   // assistant tool_use 条
  toolResult,                // tool 条 — {success, summary?, error?}
  info, error, streaming }
```

**新增 `buildMessagesForProvider(name)` 方法**，步骤：

1. **过滤**: 排除 `role==="info"` || `msg.error` || `msg.streaming === true`
2. **成对修复**（在过滤后、截断前）: 
   - 遍历列表，若 `isToolCall` 的条目后面没找到匹配 `toolCallId` 的 tool 条 → 删除该 tool_call
   - 若 `role==="tool"` 的条目前面没找到匹配的 tool_call → 删除该 tool 条
3. **截断**: 取末尾 20 条；若截断线落在 pair 中间，往前顺延到完整 pair 边界
4. **provider 映射**：

   **OpenAI/DeepSeek**:
   - user → `{role:"user", content}`
   - assistant(text) → `{role:"assistant", content}`
   - assistant(tool_call) → `{role:"assistant", content:null, tool_calls:[{id, type:"function", function:{name, arguments: JSON.stringify(args)}}]}`
   - tool → `{role:"tool", tool_call_id, content: JSON.stringify(toolResult)}`

   **Anthropic**:
   - user → `{role:"user", content}`
   - assistant(text only) → `{role:"assistant", content: [{type:"text", text: content}]}`
   - assistant(tool_use) → `{role:"assistant", content: [ ...thinkingBlocks.map(b=>({type:"thinking", thinking:b.thinking, signature:b.signature})), (content ? {type:"text", text:content} : null), {type:"tool_use", id:toolCallId, name:toolCallName, input:toolCallArgs} ].filter(Boolean)}`
   - tool → `{role:"user", content: [{type:"tool_result", tool_use_id: toolCallId, content: JSON.stringify(toolResult)}]}`

   **Gemini**:
   - user → `{role:"user", parts:[{text: content}]}`
   - assistant(text) → `{role:"model", parts:[{text: content}]}`
   - assistant(functionCall) → `{role:"model", parts:[{functionCall:{name: toolCallName, args: toolCallArgs}}]}`
   - tool → `{role:"user", parts:[{functionResponse:{name: toolCallName, response: toolResult}}]}` — `response` **必须是对象**

### Testing (Phase 4)
**Console**:
```js
const app = Alpine.$data(document.body);
// 场景 A：基本过滤 + 映射
app.messages = [
  { id:1, role:"info", content:"loaded demo" },
  { id:2, role:"user", content:"hello" },
  { id:3, role:"assistant", content:"hi there", streaming:false },
  { id:4, role:"user", content:"plan meeting" },
  { id:5, role:"assistant", isToolCall:true, toolCallId:"call_abc",
    toolCallName:"create_meeting", toolCallArgs:{raw_text:"text"},
    thinkingBlocks:[{thinking:"reasoning...", signature:"sig_xyz"}] },
  { id:6, role:"tool", toolCallId:"call_abc",
    toolResult:{success:true, summary:{no:387, segment_count:22}} }
];

const oai = app.buildMessagesForProvider('openai');
console.assert(oai.length === 5);  // info 过滤
console.assert(oai[3].tool_calls[0].id === "call_abc");
console.assert(oai[4].role === "tool" && oai[4].tool_call_id === "call_abc");

const anth = app.buildMessagesForProvider('anthropic');
console.assert(anth[3].content.length === 2);  // thinking + tool_use
console.assert(anth[3].content[0].type === "thinking" && anth[3].content[0].signature === "sig_xyz");
console.assert(anth[3].content[1].type === "tool_use");
console.assert(anth[4].content[0].type === "tool_result");

const gem = app.buildMessagesForProvider('gemini');
console.assert(gem[3].parts[0].functionCall.name === "create_meeting");
console.assert(typeof gem[4].parts[0].functionResponse.response === "object");

// 场景 B：孤立 tool_call
app.messages = [
  { id:1, role:"assistant", isToolCall:true, toolCallId:"orphan",
    toolCallName:"create_meeting", toolCallArgs:{} },
  { id:2, role:"user", content:"next turn" }
];
console.assert(app.buildMessagesForProvider('openai').length === 1);  // orphan 删除

// 场景 C：孤立 tool_result
app.messages = [
  { id:1, role:"tool", toolCallId:"orphan2", toolResult:{success:false} },
  { id:2, role:"user", content:"hello" }
];
console.assert(app.buildMessagesForProvider('openai').length === 1);  // orphan 删除
```

---

## Phase 5: sendMessage 重构 + 工具执行

### Scope

1. 删除 `isInitialParse` 判断，重写 `sendMessage()`:
   ```
   push user → build single streamingMsg → 
     history = buildMessagesForProvider(active) + currentUserTurn
     call callLLMStreaming(SYSTEM_PROMPT, null, onThinking, onContent, signal, { includeTools: true, history })
     if result.toolCalls.length:
       for each toolCall:
         push assistant-with-tool-call entry (带 thinkingBlocks)
         result = await executeToolCall(toolCall)   -- 写回同一 streamingMsg
         push tool-result entry with summary
     elif content 是合法 agenda JSON:
       applyAgendaJSON(parsed)   -- 向后兼容
     else:
       streamingMsg.isJson = false (纯文本聊天)
   finally: streamingMsg.streaming=false; set info{provider,model,effort,elapsed}
   ```

2. `executeToolCall(tc)` —— registry dispatch:
   ```
   create_meeting → callLLMStreaming(PLAN_MEETING_DEVELOPER_PROMPT,
                                     PLAN_MEETING_USER_PROMPT.replace("{text}", tc.args.raw_text),
                                     onThinking, writeToSameStreamingMsg,
                                     signal, { includeTools: false })
                  → parse + applyAgendaJSON → return {success:true, summary: digestAgenda()}
   adjust_meeting → 拼 ADJUST_MEETING_DEVELOPER_PROMPT + currentJSON,
                    userMsg = ADJUST_MEETING_USER_PROMPT.replace("{text}", tc.args.request)
                  → 同上
   失败 → {success:false, error: String(e)}
   ```

3. `applyAgendaJSON(json)` 从原 sendMessage line 578-614 整块抽出，保留所有 `??` fallback（如 `m.no ?? this.meeting.meta.no`）和 `enrichSegment` / `recalculateTimes` 调用
4. `digestAgenda()` 返回紧凑摘要：
   ```js
   { no, theme, type, start_time, end_time, segment_count,
     roles: { TOM, SAA, Timer, TTM, TTE, GE, ... }   // 角色→人名快照
   }
   ```
5. **abort**：`this.abortController.signal` 在 router 和 executor 共用；`finally` 统一清理
6. **多 tool_calls**：for 循环写死，即使通常 1 个

### Testing (Phase 5)
**UI 场景**（每家 provider 都跑一遍）:

| # | 输入 | 预期 |
|---|---|---|
| S1 | "hello" | 无 badge、纯文本回复、右侧无变化 |
| S2 | 粘贴 `prompts.js` 里 Example 1 的 input 原文 | 气泡顶部 badge `🔧 create_meeting`，下方流出 JSON，右侧出现 agenda，messages 有 tool_call + tool_result |
| S3 | 已有 agenda 后："把 Frank 换成 Joyce" | badge `🔧 adjust_meeting`，右侧 Frank 所在行变 Joyce |
| S4 | 已有 agenda 后："TOM 是谁" | 无 badge，纯文本回答应包含当前 TOM 角色名 |
| S5 | 已有 agenda 后："加个 30 分钟 workshop" | badge `🔧 adjust_meeting`，右侧新增 workshop |
| S6 | S2 生成中点 Stop | 立即停止，loading=false，streamingMsg 不标 error |

**Console 断言**（S2 完成后）:
```js
const app = Alpine.$data(document.body);
console.assert(app.messages.filter(m => m.isToolCall).length >= 1);
console.assert(app.messages.find(m => m.role === "tool").toolResult.summary.segment_count > 10);
console.assert(app.meeting.segments.length > 10);
```

**连续多轮**:
S2 → S3 → S5 → S3 四轮，每轮后 console 观察 `app.messages.length` 递增 2 (user + assistant 或 4 包含 tool pair)，第 4 轮 router 仍正确调 adjust_meeting。

---

## Phase 6: UI

### Scope
1. `streamingMsg` 模板在 `content` 上方条件渲染 badge（**同一条气泡**，不双气泡）:
   ```html
   <div x-show="msg.isToolCall" class="mb-1">
     <span class="text-[10px] bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full"
       x-text="'🔧 ' + msg.toolCallName"></span>
   </div>
   ```
2. 现有 `Updated: N segments` 绿色标改读 `msg.toolResult?.summary?.segment_count`
3. 默认 `isJson: false`；仅当流出确实是 JSON 才设 true
4. tool 失败 → `msg.toolResult.error` 红色 inline

### Testing (Phase 6)
**视觉**: S2 重跑 —— 整屏 observe 只有一个 assistant 气泡，顶部蓝色 badge，下面流式 JSON，底部绿色 `Updated: 22 segments`。右侧 segment 卡片实时出现。

**失败态**: Settings 把 OpenAI API Key 改错再跑 S2 → 红色 error 显示在同一条气泡，不崩 app。

---

## Phase 7: 错误处理分级

### Scope

1. **tool_args JSON.parse 失败** → 不挂 UI，push `{role:"tool", toolCallId, toolResult:{success:false, error:"invalid JSON: ..."}}`，让下一轮 router 看到；若同一轮内连续 2 次都失败才挂 UI error
2. **模型不支持 tools**（API 返回 tools 相关错误）: 
   - a. 自动 retry 一次不带 tools
   - b. 若 retry 成功 → 进启发式: `!segments.length` ? PLAN : ADJUST
   - c. 若 retry 也失败 → UI 红字 "Current model does not support tool calling. Switch model or use `/create` / `/adjust` prefix."
3. **Slash prefix 强制路由**（后备）: 输入以 `/create ` 或 `/adjust ` 开头 → 跳过 router，直接调 `executeToolCall` 对应 tool
4. **Executor 失败**: `toolResult.success=false`，UI 红色；tool_call 条保留在历史里（不删，否则下轮不成对）
5. **AbortError**: catch 后 `streamingMsg.streaming=false`，不标 error

### Testing (Phase 7)
**UI / Console**:

1. **Tool unsupported**: Settings OpenAI model 改成 `gpt-3.5-turbo`（该模型虽然支持 tools，但如果在自定义网关用一个不支持的 alias 也可） → 发 S2 报名文本 → Network 观察第一次 400，第二次 retry 无 tools → 启发式路径走 PLAN → UI 顶部提示警告但 agenda 仍生成
2. **Slash prefix**: 输入 `/create <报名文本>` → Network 第一个请求就是 `PLAN_MEETING_*` 提示，不走 router
3. **Abort 清理**: S2 生成中点 Stop → streamingMsg 停止但不红字
4. **坏 args retry**: 手动在 Console 内 patch `callLLMStreaming` 使其返回 `toolCalls:[{id:"x", name:"create_meeting", args:"NOT JSON"}]` → 观察 UI 不挂 error，下一条消息里 router 看到 tool_result error

---

## Phase 8: Verification Matrix

不写代码，跑测试记录结果。

### 8.1 路由用例（6 条）
| ID | Input | Expected tool | Expected content |
|---|---|---|---|
| R1 | "hello" | — | plain text |
| R2 | Example 1 的 input 全文 | create_meeting | JSON + agenda |
| R3 | 已有 agenda："把 Frank 换成 Joyce" | adjust_meeting | updated JSON |
| R4 | 已有 agenda："TOM 是谁" | — | plain text 引用 TOM 角色 |
| R5 | 已有 agenda："加个 30 分钟 workshop" | adjust_meeting | updated JSON |
| R6 | 已有 agenda："thanks" | — | plain text |

### 8.2 Provider × 场景矩阵（4 × 6 = 24）
四家 provider 逐条跑 R1–R6，登记表：

| | DeepSeek | OpenAI | Anthropic | Gemini |
|---|---|---|---|---|
| R1 | ✓/✗ | ... | ... | ... |
| R2 | ... | | | |
| ... | | | | |

### 8.3 Thinking on/off 矩阵（4 × 2 = 8）
R2 在 thinking=on 和 thinking=off 两个状态下各跑一次，每家 provider 都验 —— 两种状态都必须能正确 route + 生成。

### 8.4 必思考模型（3 条）
- OpenAI `o3` 跑 R2
- Anthropic `claude-opus-4-7` 跑 R2（adaptive 模式）
- Gemini `gemini-3.1-pro-preview` 跑 R2

### 8.5 多轮对话（1 条）
连发 R2 → R3 → R5 → R3，四家各跑一遍。第 4 轮时 `app.messages.length >= 10`，router 仍能正确选 adjust_meeting，历史传递无错（Network 里检查第 4 轮请求的 messages 数组）。

### 8.6 完成标准
- 路由矩阵 ≥ 20/24 通过
- Thinking on/off 矩阵 ≥ 7/8 通过
- 必思考模型 ≥ 2/3 通过
- 多轮对话四家都通过

失败项登记 issue，非阻塞合并（留作后续 debug）。

---

## Rollout

- Phase 1–4 可单独 commit，不影响现有功能
- Phase 5 合并时把 `isInitialParse` 的旧逻辑直接删
- Phase 8 的矩阵结果另开一个 `testing-log.md` 文档记录，不污染主分支代码
