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
    name: "set_role",
    description: "UNILATERAL: set who takes a role in ONE segment. Other fields (type, duration, start time) stay the same. For exchanging role takers between TWO segments, use swap_roles instead.",
    params: {
      segment_id: {
        type: "string",
        description: "Segment id from the current agenda snapshot (e.g. 's3', 's10')."
      },
      new_role_taker: {
        type: "string",
        description: "New role taker's name. Pass empty string to clear."
      }
    },
    required: ["segment_id", "new_role_taker"]
  },
  {
    name: "set_type",
    description: "UNILATERAL: rename ONE segment's type/title (e.g. 'Prepared Speech' → 'Ice Breaker', 'Table Topics' → '桌上话题'). Keeps id, duration, position, roleTaker, buffers unchanged. Card color may recompute automatically based on the new type's keywords.",
    params: {
      segment_id: {
        type: "string",
        description: "Segment id from the current agenda snapshot (e.g. 's3', 's10')."
      },
      new_type: {
        type: "string",
        description: "New type/title, verbatim as the user wants it displayed."
      }
    },
    required: ["segment_id", "new_type"]
  },
  {
    name: "swap_roles",
    description: "BIDIRECTIONAL: swap the role takers of TWO segments — atomic exchange of only the roleTaker field, positions and times do NOT change. Use for 'swap A and B's roles', 'Frank 和 Joyce 的角色互换'. Does NOT move the cards.",
    params: {
      segment_id_a: {
        type: "string",
        description: "Id of the first segment."
      },
      segment_id_b: {
        type: "string",
        description: "Id of the second segment."
      }
    },
    required: ["segment_id_a", "segment_id_b"]
  },
  {
    name: "set_duration",
    description: "UNILATERAL: set the duration (in minutes) of ONE segment. Downstream segment start times recompute automatically.",
    params: {
      segment_id: {
        type: "string",
        description: "Segment id from the current agenda snapshot."
      },
      new_duration_min: {
        type: "integer",
        description: "New duration in minutes, positive integer."
      }
    },
    required: ["segment_id", "new_duration_min"]
  },
  {
    name: "add_segment",
    description: "Insert a new segment. Type may be a standard Toastmasters name (e.g. 'Grammarian', 'Workshop') or a custom one (e.g. 'Ice Breaker Game'). Downstream start times recompute. Provide exactly one of after_id / before_id to anchor the position.",
    params: {
      type: {
        type: "string",
        description: "Segment type/name, verbatim as the user wants it displayed."
      },
      duration_min: {
        type: "integer",
        description: "Duration in minutes, positive integer."
      },
      after_id: {
        type: "string",
        description: "Insert AFTER the segment with this id. Provide this OR before_id, not both."
      },
      before_id: {
        type: "string",
        description: "Insert BEFORE the segment with this id. Provide this OR after_id, not both."
      },
      role_taker: {
        type: "string",
        description: "Optional role taker's name. Pass empty string if unspecified."
      }
    },
    required: ["type", "duration_min"]
  },
  {
    name: "remove_segment",
    description: "Delete an existing segment from the agenda. Downstream start times recompute automatically.",
    params: {
      segment_id: {
        type: "string",
        description: "Segment id from the current agenda snapshot."
      }
    },
    required: ["segment_id"]
  },
  {
    name: "move_segment",
    description: "UNILATERAL sequence move: relocate ONE existing segment to a new position in the agenda order. The other segments stay put — only their indices shift to make room. This is NOT a swap, and it is NOT for 'earlier/later by N minutes'. Use this for 'move X to the top', 'put Tea Break before GE', 'move the workshop to after TTM'. For exchanging two segments' positions, use swap_time instead. Keeps id/type/duration/role unchanged. Downstream start times recompute.",
    params: {
      segment_id: {
        type: "string",
        description: "Segment id of the one segment being moved."
      },
      after_id: {
        type: "string",
        description: "Move the segment to directly AFTER this other segment's id. Provide this OR before_id, not both."
      },
      before_id: {
        type: "string",
        description: "Move the segment to directly BEFORE this other segment's id. Provide this OR after_id, not both."
      }
    },
    required: ["segment_id"]
  },
  {
    name: "shift_segment_time",
    description: "UNILATERAL clock-time shift: move ONE segment earlier or later by a signed number of minutes while keeping the agenda order unchanged. Positive delta_min pushes this segment and all following segments later. Negative delta_min pulls this segment earlier by consuming the EXISTING gap before it. Do NOT use this for moving a segment before/after another segment in the order — use move_segment instead.",
    params: {
      segment_id: {
        type: "string",
        description: "Segment id from the current agenda snapshot."
      },
      delta_min: {
        type: "integer",
        description: "Signed integer minutes. Positive = later. Negative = earlier."
      }
    },
    required: ["segment_id", "delta_min"]
  },
  {
    name: "swap_time",
    description: "BIDIRECTIONAL: swap the time slots / positions of TWO segments in the agenda — they exchange where they sit in the sequence, so their start times effectively swap after downstream recomputation. Both segments keep their id/type/duration/roleTaker; only sequence positions (and thus times) are swapped. Use for 'swap A and B's time slots', '把这两张卡的时间调换一下', 'A 和 B 换个时间段'. Works for adjacent AND non-adjacent pairs — one call is always enough.",
    params: {
      segment_id_a: {
        type: "string",
        description: "Id of the first segment."
      },
      segment_id_b: {
        type: "string",
        description: "Id of the second segment."
      }
    },
    required: ["segment_id_a", "segment_id_b"]
  },
  {
    name: "set_buffer",
    description: "Set the buffer (gap/间隔) minutes BEFORE a segment. A buffer is the time gap between the previous segment ending and this segment starting — NOT a separate segment. Use this when the user asks for a 'buffer', 'gap', '间隔', or 'pause' between specific segments. Downstream start times recompute.",
    params: {
      segment_id: {
        type: "string",
        description: "Segment id of the segment AFTER the buffer (the one whose start time gets pushed back by buffer_min). For 'add 1 min buffer between PS1 and PS2', pass PS2's id."
      },
      buffer_min: {
        type: "integer",
        description: "Buffer duration in minutes. 0 means no gap (back-to-back)."
      }
    },
    required: ["segment_id", "buffer_min"]
  },
  {
    name: "set_meta",
    description: "Change a meeting-level field. Supported: theme, location, date, start_time, no, manager, introduction. end_time is derived and cannot be set directly — change start_time or segment durations instead.",
    params: {
      field: {
        type: "string",
        description: "One of: theme, location, date, start_time, no, manager, introduction."
      },
      value: {
        type: "string",
        description: "New value as a string. For 'no' pass the number as a string (e.g. '387')."
      }
    },
    required: ["field", "value"]
  },
  {
    name: "adjust_meeting",
    description: "FALLBACK ONLY. Use for complex compound requests that can't be expressed with the fine-grained tools above (e.g. 'translate all role names to Chinese', 'reorganize all evaluators by seniority'). Runs a second LLM pass and returns a fresh full agenda — slower and more expensive. Prefer fine-grained tools whenever possible.",
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
