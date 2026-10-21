"""Live-lite: continuous scene awareness from frames the phone sends every few seconds.

The vision model compares each frame against what it last saw and reports whether anything
meaningful changed. Code (not the model) then decides whether to speak, so the user hears
hazards and real changes instead of a description every two seconds.
"""

import time
from dataclasses import dataclass, field
from typing import Optional

from . import llm

HAZARD_REPEAT_S = 20  # don't repeat the same hazard warning within this window
CHANGE_MIN_GAP_S = 8  # minimum gap between non-hazard announcements
STALE_AFTER_S = 120  # live-view summary older than this isn't fed to the agent

LIVE_RULES = (
    "You watch a live camera feed for a blind person walking or exploring. You get one frame at a time, "
    "plus your summary of the previous frame. Decide what, if anything, is worth saying out loud.\n"
    "- hazard: true only for things that matter for safety in the next few steps: stairs, steps, kerbs, "
    "drop-offs, obstacles at body or head height, vehicles, wet floor, closed doors directly ahead.\n"
    "- changed: true only if the scene meaningfully differs from the previous summary (new room or area, "
    "a door, sign or person appeared). Small camera movement or lighting changes are NOT changes.\n"
    "- speak: what to say if hazard or changed, otherwise empty. One short sentence. Use clock-face "
    "directions and rough distances in steps. Read any important sign text.\n"
    "- Never say a path is safe or clear. If the frame is too dark or blurry to judge, set unclear: true.\n\n"
    "Reply with ONLY a JSON object in this exact shape: "
    '{"summary": "one sentence describing the current frame", "hazard": true|false, '
    '"changed": true|false, "unclear": true|false, "speak": "short sentence or empty string"}'
)


@dataclass
class LiveState:
    summary: str = ""
    summary_at: float = 0.0
    last_spoken: str = ""
    last_spoken_at: float = 0.0
    last_hazard: str = ""
    last_hazard_at: float = 0.0
    unclear_streak: int = 0
    history: list = field(default_factory=list)  # recent (time, summary) for the agent's context


_sessions: dict[str, LiveState] = {}


def state(session_id: str) -> LiveState:
    return _sessions.setdefault(session_id, LiveState())


def reset(session_id: str) -> None:
    _sessions.pop(session_id, None)


def context_for_agent(session_id: str) -> Optional[str]:
    """Recent live-view summary, so push-to-talk questions during live mode can use it."""
    s = _sessions.get(session_id)
    if not s or not s.summary or time.time() - s.summary_at > STALE_AFTER_S:
        return None
    return f"LIVE VIEW ({int(time.time() - s.summary_at)}s ago): {s.summary}"


def _bool(v) -> bool:
    return v is True or (isinstance(v, str) and v.strip().lower() == "true")


def process_frame(session_id: str, image: bytes, mission_hint: str = "") -> dict:
    s = state(session_id)
    prompt = f"Previous summary: {s.summary or '(none, this is the first frame)'}"
    if mission_hint:
        prompt += f"\nThe user is currently trying to: {mission_hint}. Mention it if you see it."

    started = time.time()
    try:
        data = llm.vision_json(LIVE_RULES, prompt, image, fast=True)
    except llm.AllProvidersBusy as e:
        # Every provider is cooling down: skip this frame and tell the phone when to try again.
        return {"speak": "", "hazard": False, "reason": "busy", "backoff_s": round(min(max(e.retry_after, 2.0), 15.0), 1),
                "summary": s.summary, "latency_s": round(time.time() - started, 2)}
    latency = round(time.time() - started, 2)

    now = time.time()
    first_frame = not s.summary
    summary = str(data.get("summary") or "").strip()
    hazard = _bool(data.get("hazard"))
    changed = _bool(data.get("changed"))
    unclear = _bool(data.get("unclear"))
    speak = str(data.get("speak") or "").strip()

    if summary:
        s.summary, s.summary_at = summary, now
        s.history = (s.history + [(now, summary)])[-10:]

    say = ""
    reason = "quiet"
    s.unclear_streak = s.unclear_streak + 1 if unclear else 0
    if hazard and speak:
        if speak != s.last_hazard or now - s.last_hazard_at > HAZARD_REPEAT_S:
            say, reason = speak, "hazard"
            s.last_hazard, s.last_hazard_at = speak, now
        else:
            reason = "hazard_repeat_suppressed"
    elif first_frame and (speak or summary):
        # Starting live mode should immediately say what's in view, not wait for something to change.
        # Even an "unclear" first frame speaks: "I can't see well, raise the phone" is useful right away.
        say, reason = speak or summary, "first"
    elif changed and speak and now - s.last_spoken_at > CHANGE_MIN_GAP_S and speak != s.last_spoken:
        say, reason = speak, "change"
    elif s.unclear_streak == 3:
        # Tell the user once, not every frame, that the camera can't see well.
        say, reason = "I can't see clearly. Try holding the phone steady at chest height.", "unclear"

    if say:
        s.last_spoken, s.last_spoken_at = say, now

    return {"speak": say, "hazard": hazard and reason == "hazard", "reason": reason, "summary": summary,
            "latency_s": latency, "provider": data.get("_provider")}
