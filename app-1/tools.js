// ============================================================
// Tool registry for LLM function calling.
// Adapters convert a single canonical definition into the three
// provider-specific shapes. Add new tools to TOOL_REGISTRY only —
// the exported schemas regenerate automatically.
// ============================================================

const TOOL_REGISTRY = [
  {
    name: "create_meeting",
    description: "Generate a new meeting agenda from raw registration text the user just pasted. Call ONLY when the user pastes WeChat-style registration text (contains a date, a theme, and role assignments like 'TOM: Rui'). Do NOT call for chit-chat or questions.",
    params: {
      raw_text: {
        type: "string",
        description: "The full registration text the user pasted, verbatim."
      }
    },
    required: ["raw_text"]
  },
  {
    name: "adjust_meeting",
    description: "Modify the existing meeting agenda according to the user's request (swap roles, change durations, add or remove segments). Requires an agenda to already exist in the conversation. Do NOT call to answer questions about the existing agenda.",
    params: {
      request: {
        type: "string",
        description: "The user's modification request, verbatim."
      }
    },
    required: ["request"]
  }
];

function toOpenAI(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties: tool.params,
        required: tool.required || []
      }
    }
  };
}

function toAnthropic(tool) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: "object",
      properties: tool.params,
      required: tool.required || []
    }
  };
}

// Gemini requires uppercase OpenAPI types (OBJECT/STRING/ARRAY/...) throughout.
function upperTypes(schema) {
  if (schema === null || typeof schema !== "object") return schema;
  const out = Array.isArray(schema) ? [] : {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "type" && typeof v === "string") out[k] = v.toUpperCase();
    else out[k] = upperTypes(v);
  }
  return out;
}

function toGemini(tool) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: upperTypes({
      type: "object",
      properties: tool.params,
      required: tool.required || []
    })
  };
}

const TOOLS_OPENAI = TOOL_REGISTRY.map(toOpenAI);
const TOOLS_ANTHROPIC = TOOL_REGISTRY.map(toAnthropic);
const TOOLS_GEMINI = [{ functionDeclarations: TOOL_REGISTRY.map(toGemini) }];
