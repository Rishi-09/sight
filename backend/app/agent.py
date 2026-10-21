import json

from sqlmodel import select

from . import live, llm
from .db import Message, Preference, active_mission, mission_view
from .tools import DECLARATIONS, ToolContext, all_destinations, run_tool, step_payload

MAX_TOOL_TURNS = 5
HISTORY_TURNS = 10
# Context budget: keep the newest history that fits, so every request stays small enough to run
# on any provider's free-tier per-minute token limit. ~4 chars per token.
HISTORY_CHAR_BUDGET = 4000
TOOL_RESULT_CHAR_LIMIT = 2000

SYSTEM = """You are SIGHT, a voice assistant for people who are blind or have low vision.
Your replies are spoken aloud by text-to-speech, so:
- Keep replies short: 1-3 sentences unless the user asks for more. No markdown, lists, or emojis.
- Lead with the most useful information.

How to act:
- Understand the user's goal and call tools to accomplish it. You may call several tools in a row.
- A camera photo is attached to most requests. Use describe_scene or read_text when the question is about the surroundings; never guess what is visible without calling them.
- If a tool reports low confidence, say plainly that you're not sure and suggest what to do (move the camera, get closer, ask someone nearby).
- Never say a route or path is safe. You give guidance; the user's cane, guide dog, and own judgement come first.
- Before starting a navigation mission, confirm the destination with the user in one short question, unless they already clearly confirmed it.
- During a mission, keep the user oriented: after advancing, read out the new step's instruction and landmark hint. At the entrance step, use describe_scene with the expected entrance description.
- When reporting a belonging's location, say when it was recorded and that it may have moved.
- If the request is outside what your tools can do, say so honestly.
- Reply in the same language the user speaks (English or Hindi).

Operating the app:
- The user is blind and controls the app by voice. When they ask the app to do something (stop or start live mode, repeat, stop talking, next step, open maps or memory, go home), call control_app with the matching action, then confirm in a few words ("Live mode off."). Don't describe the screen or tell them which button to press.
- For "repeat" or "say that again", call control_app with "repeat" and reply with an empty-ish confirmation like "Repeating."; the phone replays its previous answer itself.

Maps (you CAN add maps; never say you can't):
- To add a place or a map, call create_place. Then explain briefly: walk the route from the usual start, and at each turn say "add a point here" with what to do there.
- When the user is recording a route and says something like "add a point here, turn left at the gate", call add_route_point with their place and instruction. It uses their current GPS. If they don't say which place, use the one most recently created or discussed.
- A sighted helper can also use the Maps screen (control_app open_maps) to see the route on a map and edit it.
- To change your name / wake word, call set_wake_word.
"""


def _context_block(ctx: ToolContext) -> str:
    parts = []
    m = active_mission(ctx.db, ctx.session_id)
    if m:
        parts.append("ACTIVE MISSION: " + json.dumps(step_payload(ctx, m)))
        d = next((x for x in all_destinations(ctx.db) if x["id"] == m.destination_id), None)
        if d:
            parts.append(f"Known rooms in {d['name']}: {list(d['rooms'])}")
    else:
        parts.append("No active mission. Supported destinations: " + ", ".join(d["name"] for d in all_destinations(ctx.db)))
    prefs = ctx.db.exec(select(Preference).where(Preference.session_id == ctx.session_id)).all()
    if prefs:
        parts.append("USER PREFERENCES: " + json.dumps({p.key: p.value for p in prefs}))
    live_view = live.context_for_agent(ctx.session_id)
    if live_view:
        parts.append(live_view)
    parts.append("Camera image attached: " + ("yes" if ctx.image else "no"))
    parts.append("GPS: " + (f"{ctx.lat:.5f},{ctx.lng:.5f}" if ctx.lat is not None else "unavailable"))
    return "\n".join(parts)


def run(ctx: ToolContext, user_text: str) -> dict:
    history = ctx.db.exec(
        select(Message).where(Message.session_id == ctx.session_id).order_by(Message.id.desc()).limit(HISTORY_TURNS * 2)
    ).all()[::-1]

    # Newest turns first until the budget runs out, then restore chronological order.
    kept, used = [], 0
    for h in reversed(history):
        used += len(h.text)
        if used > HISTORY_CHAR_BUDGET and kept:
            break
        kept.append({"role": h.role if h.role == "user" else "assistant", "content": h.text})
    kept.reverse()
    if kept and kept[0]["role"] == "assistant":
        kept = kept[1:]  # never open the history mid-exchange

    messages: list[dict] = [{"role": "system", "content": SYSTEM}, *kept]
    messages.append({"role": "user", "content": f"[context]\n{_context_block(ctx)}\n[/context]\n\n{user_text}"})

    tool_log = []
    reply = ""
    providers_used = []
    for _ in range(MAX_TOOL_TURNS + 1):
        resp, provider = llm.complete("text", messages, tools=DECLARATIONS, tool_choice="auto", temperature=0.3)
        providers_used.append(provider)
        msg = resp.choices[0].message
        calls = msg.tool_calls or []
        if not calls:
            reply = (msg.content or "").strip()
            break
        messages.append({
            "role": "assistant",
            "content": msg.content,
            "tool_calls": [
                {"id": c.id, "type": "function", "function": {"name": c.function.name, "arguments": c.function.arguments}}
                for c in calls
            ],
        })
        for call in calls:
            try:
                args = json.loads(call.function.arguments or "{}")
            except json.JSONDecodeError:
                args = {}
            result = run_tool(ctx, call.function.name, args)
            tool_log.append({"tool": call.function.name, "args": args, "result": result})
            content = json.dumps({"result": result})
            if len(content) > TOOL_RESULT_CHAR_LIMIT:
                content = content[:TOOL_RESULT_CHAR_LIMIT] + '..."(truncated)"'
            messages.append({"role": "tool", "tool_call_id": call.id, "content": content})
    else:
        reply = "Sorry, I got stuck working on that. Could you ask again more simply?"

    if not reply:
        reply = "Sorry, I didn't catch that. Could you say it again?"

    ctx.db.add(Message(session_id=ctx.session_id, role="user", text=user_text))
    ctx.db.add(Message(session_id=ctx.session_id, role="assistant", text=reply))
    ctx.db.commit()

    return {
        "reply": reply,
        "confidence": ctx.confidence,
        "tools": tool_log,
        "providers": providers_used,
        "actions": ctx.actions,
        "mission": mission_view(active_mission(ctx.db, ctx.session_id)),
    }
