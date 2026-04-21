// ============================================================
// Time-shift semantics for agenda segments.
// Pure helpers shared by the browser app and Node tests.
// ============================================================

function minutesLabel(min) {
  const n = Math.abs(parseInt(min, 10)) || 0;
  return n + " min";
}

function analyzeShiftSegment(segments, segmentIndex, deltaMin) {
  const delta = parseInt(deltaMin, 10);
  if (!Number.isFinite(delta)) {
    return {
      ok: false,
      reason: "invalid_delta",
      error: "delta_min must be an integer.",
      userMessage: "Please specify the time shift as an integer number of minutes."
    };
  }

  const seg = Array.isArray(segments) ? segments[segmentIndex] : null;
  if (!seg) {
    return {
      ok: false,
      reason: "missing_segment",
      error: "Segment not found.",
      userMessage: "I couldn't find that segment in the current agenda."
    };
  }

  const availableGapMin = Math.max(parseInt(seg.bufferBefore, 10) || 0, 0);

  if (delta === 0) {
    return {
      ok: true,
      reason: "noop",
      direction: "none",
      requestedDeltaMin: 0,
      availableGapMin
    };
  }

  if (delta > 0) {
    return {
      ok: true,
      reason: "later_ok",
      direction: "later",
      requestedDeltaMin: delta,
      availableGapMin
    };
  }

  const requestedEarlierMin = Math.abs(delta);
  if (segmentIndex === 0) {
    return {
      ok: false,
      reason: "first_segment",
      direction: "earlier",
      requestedDeltaMin: delta,
      requestedEarlierMin,
      availableGapMin: 0,
      error: "Cannot move the first segment earlier without moving the meeting start time earlier.",
      userMessage: "I can't move the first segment earlier on its own. To make it start earlier, move the meeting start time earlier instead."
    };
  }

  if (requestedEarlierMin <= availableGapMin) {
    return {
      ok: true,
      reason: "earlier_ok",
      direction: "earlier",
      requestedDeltaMin: delta,
      requestedEarlierMin,
      availableGapMin
    };
  }

  return {
    ok: false,
    reason: "insufficient_gap",
    direction: "earlier",
    requestedDeltaMin: delta,
    requestedEarlierMin,
    availableGapMin,
    shortageMin: requestedEarlierMin - availableGapMin,
    error: "Cannot move earlier by " + minutesLabel(requestedEarlierMin) + ". Only " + minutesLabel(availableGapMin) + " gap is available before this segment.",
    userMessage: "I can't move this segment " + minutesLabel(requestedEarlierMin) + " earlier because there are only " + minutesLabel(availableGapMin) + " of free gap before it."
  };
}

function buildShiftConflictResult(segment, analysis) {
  const label = segment?.type || "This segment";
  const base = {
    success: false,
    conflict: true,
    segment_id: segment?.id || null,
    segment_type: segment?.type || "",
    requested_delta_min: analysis?.requestedDeltaMin ?? null,
    max_earlier_min: analysis?.availableGapMin ?? 0
  };

  if (!analysis || analysis.ok) {
    return {
      ...base,
      conflict: false,
      error: "No shift conflict."
    };
  }

  if (analysis.reason === "first_segment") {
    const suggestions = [
      "Move the meeting start time earlier instead.",
      "If you meant reordering rather than time shifting, move the segment to a different position in the agenda."
    ];
    return {
      ...base,
      error: analysis.error,
      suggestions,
      user_message: label + " is the first segment, so it cannot start earlier unless the meeting start time moves earlier."
    };
  }

  if (analysis.reason === "insufficient_gap") {
    const suggestions = [
      "Move it earlier by at most " + minutesLabel(analysis.availableGapMin) + ".",
      "Shorten the previous segment or reduce an earlier buffer.",
      "Move the meeting start time earlier if the whole agenda should begin earlier.",
      "If you meant reordering rather than time shifting, move it before/after another segment instead."
    ];
    return {
      ...base,
      error: analysis.error,
      suggestions,
      user_message: label + " can only move earlier by up to " + minutesLabel(analysis.availableGapMin) + " right now. Larger earlier moves would overlap the previous segment."
    };
  }

  return {
    ...base,
    error: analysis.error || "Cannot shift this segment time.",
    suggestions: [],
    user_message: analysis.userMessage || analysis.error || "Cannot shift this segment time."
  };
}
