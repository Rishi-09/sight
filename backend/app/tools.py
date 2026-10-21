"""Whitelisted tools the agent may call. The LLM can only reach the phone and data through these."""

import difflib
import json
import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

from sqlmodel import Session, select

from . import llm
from .db import Mission, Observation, Place, Preference, Waypoint, active_mission, mission_view

CAMPUS = json.loads((Path(__file__).parent / "campus.json").read_text(encoding="utf-8"))
ARRIVAL_RADIUS_M = 15

# Phone-side actions the agent may trigger. The app executes them; the agent can't do anything else
# on the device.
APP_ACTIONS = [
    "live_on", "live_off", "repeat", "stop_speaking", "next_step",
    "open_maps", "open_memory", "open_menu", "go_home", "review_on", "review_off",
]


@dataclass
class ToolContext:
    db: Session
    session_id: str
    image: Optional[bytes] = None
    lat: Optional[float] = None
    lng: Optional[float] = None
    heading: Optional[float] = None  # compass degrees, when the phone has one
    confidence: Optional[str] = None  # lowest vision confidence seen this turn
    actions: list = field(default_factory=list)  # app actions requested via control_app this turn


# ---------- helpers ----------

def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def time_ago(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    secs = int((datetime.now(timezone.utc) - dt).total_seconds())
    if secs < 60:
        return "just now"
    if secs < 3600:
        return f"{secs // 60} minutes ago"
    if secs < 86400:
        return f"{secs // 3600} hours ago"
    return f"{secs // 86400} days ago"


def place_as_destination(p: Place, waypoints: list[Waypoint]) -> dict:
    """Recorded places use the same shape as campus.json destinations, so missions treat both alike."""
    return {
        "id": f"place_{p.id}",
        "name": p.name,
        "aliases": [a.strip().lower() for a in p.aliases.split(",") if a.strip()],
        "route": [
            {"instruction": w.instruction or f"Continue to point {w.seq}.", "lat": w.lat, "lng": w.lng, "landmark_hint": w.landmark_hint}
            for w in sorted(waypoints, key=lambda w: w.seq)
        ],
        "entrance": p.entrance or f"the entrance of {p.name}",
        "rooms": json.loads(p.rooms_json or "{}"),
        "source": "recorded",
    }


def all_destinations(db: Session) -> list[dict]:
    """Recorded places first (they're the user's real campus), then the sample campus.json."""
    places = db.exec(select(Place)).all()
    wps = db.exec(select(Waypoint)).all()
    recorded = [place_as_destination(p, [w for w in wps if w.place_id == p.id]) for p in places]
    return recorded + CAMPUS["destinations"]


def find_destination(query: str, destinations: list[dict]) -> Optional[dict]:
    q = query.lower().strip()
    best, best_score = None, 0.0
    for d in destinations:
        for name in [d["name"].lower(), d["id"].replace("_", " "), *d["aliases"]]:
            score = 1.0 if (name in q or q in name) else difflib.SequenceMatcher(None, q, name).ratio()
            if score > best_score:
                best, best_score = d, score
    return best if best_score >= 0.6 else None


def _lower_confidence(ctx: ToolContext, c: str) -> None:
    order = {"low": 0, "medium": 1, "high": 2}
    if ctx.confidence is None or order.get(c, 0) < order.get(ctx.confidence, 2):
        ctx.confidence = c


def step_payload(ctx: ToolContext, m: Mission) -> dict:
    view = mission_view(m)
    step = view["step"]
    out = {"mission": view["destination"], "step_number": m.current_step + 1, "total_steps": view["total_steps"], "step": step}
    if step and step.get("lat") is not None and ctx.lat is not None:
        out["distance_to_step_point_m"] = round(haversine_m(ctx.lat, ctx.lng, step["lat"], step["lng"]))
        out["gps_note"] = "Phone GPS is often off by 5-20 metres; treat distance as approximate."
    return out


# ---------- tools ----------

def describe_scene(ctx: ToolContext, question: str, expected: str = "") -> dict:
    if not ctx.image:
        return {"error": "No camera image was sent with this request. Ask the user to point the camera and try again."}
    prompt = question
    if expected:
        prompt += f"\n\nFor reference, the user expects to find: {expected}. Say whether you can see something matching it, and where. Do not assume it is there."
    result = llm.vision(prompt, ctx.image)
    _lower_confidence(ctx, result.get("confidence", "low"))
    return result


def read_text(ctx: ToolContext) -> dict:
    if not ctx.image:
        return {"error": "No camera image was sent. Ask the user to point the camera at the text."}
    result = llm.vision(
        "Read all legible text in this image in natural reading order. Put it in visible_text. "
        "In answer, give a one-sentence summary of what the text is (sign, document, label...) and any dates, times or locations. "
        "If parts are cut off or unreadable, say so.",
        ctx.image,
    )
    _lower_confidence(ctx, result.get("confidence", "low"))
    return result


def save_observation(ctx: ToolContext, object_name: str, location_note: str) -> dict:
    scene = ""
    if ctx.image:
        scene = llm.vision(
            f"In one sentence, describe where the {object_name} is in this image relative to nearby furniture or landmarks. If you cannot see it, say so.",
            ctx.image,
        ).get("answer", "")
    obs = Observation(
        session_id=ctx.session_id,
        object_name=object_name.lower().strip(),
        location_note=location_note,
        scene_description=scene,
        lat=ctx.lat,
        lng=ctx.lng,
    )
    ctx.db.add(obs)
    ctx.db.commit()
    return {"saved": True, "object": obs.object_name, "location_note": location_note, "camera_saw": scene}


def find_object(ctx: ToolContext, object_name: str) -> dict:
    q = object_name.lower().strip()
    rows = ctx.db.exec(
        select(Observation).where(Observation.session_id == ctx.session_id).order_by(Observation.created_at.desc())
    ).all()

    def match(o: Observation) -> bool:
        return q in o.object_name or o.object_name in q or difflib.SequenceMatcher(None, q, o.object_name).ratio() > 0.7

    hits = [o for o in rows if match(o)]
    if not hits:
        return {"found": False, "known_objects": sorted({o.object_name for o in rows})}
    o = hits[0]
    return {
        "found": True,
        "object": o.object_name,
        "location_note": o.location_note,
        "camera_saw": o.scene_description,
        "recorded": time_ago(o.created_at),
        "caveat": "This is where it was last recorded, not a verified current location.",
        "older_records": len(hits) - 1,
    }


def list_destinations(ctx: ToolContext) -> dict:
    return {"destinations": [d["name"] for d in all_destinations(ctx.db)], "start_point": CAMPUS["start_name"]}


def start_mission(ctx: ToolContext, destination: str, room: str = "") -> dict:
    d = find_destination(destination, all_destinations(ctx.db))
    if d is None:
        return {"error": f"'{destination}' is not a known destination.", **list_destinations(ctx)}
    if not d["route"]:
        return {"error": f"{d['name']} has no recorded route yet. Someone needs to record it in the Maps screen."}

    steps = [{"kind": "walk", **s} for s in d["route"]]
    steps.append({
        "kind": "entrance",
        "instruction": f"You should be close to the {d['name']}. Point your camera ahead and ask me to find the entrance.",
        "expected": d["entrance"],
    })
    room_info = None
    if room:
        key = next((k for k in d["rooms"] if k.lower() == room.lower().strip()), None) or next(
            (k for k in d["rooms"] if room.lower() in k.lower() or k.lower() in room.lower()), None
        )
        if key:
            room_info = key
            steps.append({"kind": "room", "instruction": f"Inside, to reach {key}: {d['rooms'][key]}", "room": key})

    for old in ctx.db.exec(select(Mission).where(Mission.session_id == ctx.session_id, Mission.status == "active")).all():
        old.status = "cancelled"
    m = Mission(session_id=ctx.session_id, destination_id=d["id"], destination_name=d["name"], steps_json=json.dumps(steps))
    ctx.db.add(m)
    ctx.db.commit()
    ctx.db.refresh(m)
    out = step_payload(ctx, m)
    out["started"] = True
    out["assumed_start"] = CAMPUS["start_name"]
    if room and not room_info:
        out["room_warning"] = f"Room '{room}' is not in my data for this building. Known rooms: {list(d['rooms'])}"
    return out


def get_mission_step(ctx: ToolContext) -> dict:
    m = active_mission(ctx.db, ctx.session_id)
    if m is None:
        return {"active": False}
    return step_payload(ctx, m)


def advance_mission(ctx: ToolContext) -> dict:
    m = active_mission(ctx.db, ctx.session_id)
    if m is None:
        return {"active": False}
    return _advance(ctx, m)


def _advance(ctx: ToolContext, m: Mission) -> dict:
    m.current_step += 1
    if m.current_step >= len(m.steps):
        m.status = "completed"
        ctx.db.add(m)
        ctx.db.commit()
        return {"completed": True, "mission": m.destination_name,
                "note": "All guidance steps are done. Arrival is based on the user confirming steps, not verified position."}
    ctx.db.add(m)
    ctx.db.commit()
    return step_payload(ctx, m)


def add_room_to_mission(ctx: ToolContext, room: str) -> dict:
    m = active_mission(ctx.db, ctx.session_id)
    if m is None:
        return {"error": "No active mission."}
    d = next((x for x in all_destinations(ctx.db) if x["id"] == m.destination_id), None)
    if d is None:
        return {"error": "This destination no longer exists in the map data."}
    key = next((k for k in d["rooms"] if room.lower() in k.lower() or k.lower() in room.lower()), None)
    if key is None:
        return {"error": f"Room '{room}' not found.", "known_rooms": list(d["rooms"])}
    steps = m.steps
    steps = [s for s in steps if s["kind"] != "room"]
    steps.append({"kind": "room", "instruction": f"Inside, to reach {key}: {d['rooms'][key]}", "room": key})
    m.steps_json = json.dumps(steps)
    ctx.db.add(m)
    ctx.db.commit()
    return {"added": key, "directions": d["rooms"][key]}


def cancel_mission(ctx: ToolContext) -> dict:
    m = active_mission(ctx.db, ctx.session_id)
    if m is None:
        return {"active": False}
    m.status = "cancelled"
    ctx.db.add(m)
    ctx.db.commit()
    return {"cancelled": True, "mission": m.destination_name}


def _find_place(ctx: ToolContext, name: str) -> Optional[Place]:
    places = ctx.db.exec(select(Place)).all()
    q = name.lower().strip()
    best, best_score = None, 0.0
    for p in places:
        for candidate in [p.name.lower(), *[a.strip().lower() for a in p.aliases.split(",") if a.strip()]]:
            score = 1.0 if (candidate in q or q in candidate) else difflib.SequenceMatcher(None, q, candidate).ratio()
            if score > best_score:
                best, best_score = p, score
    return best if best_score >= 0.6 else None


def create_place(ctx: ToolContext, name: str, entrance: str = "") -> dict:
    name = name.strip()
    if not name:
        return {"error": "A place needs a name."}
    existing = _find_place(ctx, name)
    if existing and existing.name.lower() == name.lower():
        return {"exists": True, "place": existing.name, "note": "Already exists; add route points to it."}
    p = Place(name=name, entrance=entrance)
    ctx.db.add(p)
    ctx.db.commit()
    return {"created": p.name, "next": "Walk the route from the usual starting point; at each turn, add a route point with an instruction."}


def add_route_point(ctx: ToolContext, place: str, instruction: str, landmark: str = "") -> dict:
    if ctx.lat is None or ctx.lng is None:
        return {"error": "No GPS position from the phone right now, so I can't record a point. Try again outdoors in a moment."}
    p = _find_place(ctx, place)
    if p is None:
        return {"error": f"No recorded place called '{place}'. Create it first.", "places": [x.name for x in ctx.db.exec(select(Place)).all()]}
    last = ctx.db.exec(select(Waypoint).where(Waypoint.place_id == p.id).order_by(Waypoint.seq.desc())).first()
    w = Waypoint(place_id=p.id, seq=(last.seq + 1) if last else 1, lat=ctx.lat, lng=ctx.lng, heading=ctx.heading,
                 instruction=instruction.strip(), landmark_hint=landmark.strip())
    ctx.db.add(w)
    ctx.db.commit()
    return {"saved_point": w.seq, "place": p.name, "instruction": w.instruction, "gps": [round(ctx.lat, 6), round(ctx.lng, 6)]}


def set_wake_word(ctx: ToolContext, name: str) -> dict:
    clean = " ".join(name.strip().split())
    if not (2 <= len(clean) <= 20) or not all(ch.isalpha() or ch == " " for ch in clean) or len(clean.split()) > 2:
        return {"error": "The name should be one or two words, letters only."}
    ctx.actions.append(f"set_wake_word:{clean}")
    return {"queued": f"Wake word will become '{clean}'."}


def control_app(ctx: ToolContext, action: str) -> dict:
    action = action.strip().lower()
    if action not in APP_ACTIONS:
        return {"error": f"Unknown action '{action}'.", "allowed": APP_ACTIONS}
    ctx.actions.append(action)
    return {"queued": action, "note": "The phone performs this after your reply is spoken."}


def remember_preference(ctx: ToolContext, key: str, value: str) -> dict:
    key = key.lower().strip()
    row = ctx.db.exec(select(Preference).where(Preference.session_id == ctx.session_id, Preference.key == key)).first()
    if row is None:
        row = Preference(session_id=ctx.session_id, key=key, value=value)
    else:
        row.value = value
    ctx.db.add(row)
    ctx.db.commit()
    return {"remembered": {key: value}}


# ---------- registry ----------
# Tool schemas in OpenAI/Groq function-calling format: {"type": "function", "function": {...}}.

def _fn(name: str, desc: str, props: dict | None = None, required: list[str] | None = None) -> dict:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": desc,
            "parameters": {
                "type": "object",
                "properties": {k: {"type": "string", "description": v} for k, v in (props or {}).items()},
                "required": required or [],
            },
        },
    }


DECLARATIONS = [
    _fn("describe_scene", "Look through the phone camera to describe the surroundings or answer a visual question (doors, signs, objects, obstacles, entrances).",
        {"question": "What to look for or answer, phrased fully.", "expected": "Optional description of what the user expects to find, e.g. the known entrance description during a mission."},
        ["question"]),
    _fn("read_text", "Read printed text visible to the camera (signs, documents, labels, notices)."),
    _fn("save_observation", "Record where a personal belonging is right now, when the user says they put or see something somewhere.",
        {"object_name": "The object, e.g. 'black backpack'.", "location_note": "Where it is, in the user's words."},
        ["object_name", "location_note"]),
    _fn("find_object", "Look up the last recorded location of a personal belonging.",
        {"object_name": "The object to find."}, ["object_name"]),
    _fn("list_destinations", "List campus destinations that guided missions support."),
    _fn("start_mission", "Start a guided navigation mission to a campus destination. Only call after the user has confirmed the destination.",
        {"destination": "Destination name as the user said it.", "room": "Optional room inside the building."}, ["destination"]),
    _fn("get_mission_step", "Get the current step of the active mission, including GPS distance to the step point when available."),
    _fn("advance_mission", "Mark the current mission step as done and move to the next one. Call when the user says they've done a step, or says 'next'."),
    _fn("add_room_to_mission", "Add or change the room the user wants to reach inside the mission's destination building.",
        {"room": "Room name or number."}, ["room"]),
    _fn("cancel_mission", "Cancel the active mission. Only when the user asks to stop."),
    _fn("remember_preference", "Store a durable user preference the user explicitly asked you to remember (e.g. speaking speed, language, preferred name).",
        {"key": "Short preference name.", "value": "Preference value."}, ["key", "value"]),
    _fn("create_place", "Create a new destination on the user's map (e.g. 'Hostel Block B'), so routes to it can be recorded and guided later. Use when the user wants to add a place or a map.",
        {"name": "Name of the place.", "entrance": "Optional description of its entrance."}, ["name"]),
    _fn("add_route_point", "Record a route point at the user's CURRENT GPS position for a place, with a spoken instruction for that spot. Use while the user walks a route to a place and says e.g. 'add a point here, turn right at the tea stall'.",
        {"place": "Which place this route leads to.", "instruction": "What to do at this spot, e.g. 'Turn right at the tea stall'.", "landmark": "Optional sound, smell or texture that marks this spot."},
        ["place", "instruction"]),
    _fn("set_wake_word", "Change the name the user calls the assistant by (the wake word), e.g. 'Buddy'. Use when they ask to change your name.",
        {"name": "The new name, one or two words."}, ["name"]),
    {
        "type": "function",
        "function": {
            "name": "control_app",
            "description": (
                "Operate the SIGHT app for the user, who can't see the screen. Use whenever the user asks the app to do "
                "something: start/stop live mode, repeat the last answer, stop talking, next mission step, open the maps, "
                "memory or menu screen, go back home, or turn 'review before sending' on/off. Call once per action."
            ),
            "parameters": {
                "type": "object",
                "properties": {"action": {"type": "string", "enum": APP_ACTIONS, "description": "The app action to perform."}},
                "required": ["action"],
            },
        },
    },
]

REGISTRY: dict[str, Callable[..., dict]] = {
    "describe_scene": describe_scene,
    "read_text": read_text,
    "save_observation": save_observation,
    "find_object": find_object,
    "list_destinations": list_destinations,
    "start_mission": start_mission,
    "get_mission_step": get_mission_step,
    "advance_mission": advance_mission,
    "add_room_to_mission": add_room_to_mission,
    "cancel_mission": cancel_mission,
    "remember_preference": remember_preference,
    "control_app": control_app,
    "create_place": create_place,
    "add_route_point": add_route_point,
    "set_wake_word": set_wake_word,
}


def run_tool(ctx: ToolContext, name: str, args: dict) -> dict:
    fn = REGISTRY.get(name)
    if fn is None:
        return {"error": f"Unknown tool {name}."}
    try:
        return fn(ctx, **(args or {}))
    except TypeError as e:
        return {"error": f"Bad arguments for {name}: {e}"}
