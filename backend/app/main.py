import json
import logging
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlmodel import delete, select

from . import agent, live, llm
from .db import Message, Mission, Observation, Place, Preference, Waypoint, active_mission, get_session, init_db, mission_view
from .tools import CAMPUS, ToolContext, _advance

log = logging.getLogger("sight")
app = FastAPI(title="SIGHT")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# Groq's Whisper endpoint accepts these extensions; the mobile app records .m4a.
GROQ_AUDIO_EXTS = {".flac", ".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".ogg", ".wav", ".webm"}


@app.on_event("startup")
def _startup() -> None:
    init_db()


def _spoken_step(view: Optional[dict]) -> str:
    if not view:
        return "There's no active mission."
    step = view["step"]
    text = f"Step {view['current_step'] + 1} of {view['total_steps']}. {step['instruction']}"
    if step.get("landmark_hint"):
        text += f" Landmark: {step['landmark_hint']}."
    return text


async def _run_agent(text: str, session_id: str, image: Optional[UploadFile], lat: Optional[float], lng: Optional[float],
                     heading: Optional[float] = None) -> dict:
    img = await image.read() if image else None
    with get_session() as db:
        ctx = ToolContext(db=db, session_id=session_id, image=img or None, lat=lat, lng=lng, heading=heading)
        try:
            return agent.run(ctx, text)
        except RuntimeError as e:
            raise HTTPException(500, str(e))
        except llm.AllProvidersBusy as e:
            # The phone retries once by itself (with a spoken "one moment"), so this reply is only
            # heard if the retry is also busy.
            return {
                "reply": "Sorry, I need a few more seconds. Please ask me again in a moment.",
                "confidence": None, "tools": [], "error": str(e),
                "busy_retry_after": round(min(max(e.retry_after, 1.0), 10.0), 1),
                "mission": mission_view(active_mission(db, session_id)),
            }
        except Exception as e:  # unexpected errors from a model provider
            log.exception("agent failed")
            return {
                "reply": "Sorry, something went wrong on my side. Please ask me again.",
                "confidence": None, "tools": [], "error": str(e),
                "busy_retry_after": 1.5,
                "mission": mission_view(active_mission(db, session_id)),
            }


@app.get("/health")
def health() -> dict:
    return {"ok": True, "vision": llm.VISION_PROVIDER, "stt_model": llm.STT_MODEL, "providers": llm.status()}


@app.post("/live/frame")
async def live_frame(image: UploadFile = File(...), session_id: str = Form("demo")) -> dict:
    """One frame of live mode. Returns text to speak only for hazards or meaningful changes."""
    data = await image.read()
    hint = ""
    with get_session() as db:
        m = active_mission(db, session_id)
        if m:
            step = mission_view(m)["step"] or {}
            hint = step.get("expected") or step.get("landmark_hint") or step.get("instruction", "")
    try:
        return live.process_frame(session_id, data, hint)
    except Exception as e:
        log.exception("live frame failed")
        return {"speak": "", "hazard": False, "reason": "error", "error": str(e)}


@app.delete("/live/{session_id}")
def live_stop(session_id: str) -> dict:
    live.reset(session_id)
    return {"stopped": True}


@app.post("/chat")
async def chat(
    text: str = Form(...),
    session_id: str = Form("demo"),
    image: Optional[UploadFile] = File(None),
    lat: Optional[float] = Form(None),
    lng: Optional[float] = Form(None),
    heading: Optional[float] = Form(None),
) -> dict:
    return await _run_agent(text, session_id, image, lat, lng, heading)


@app.post("/transcribe")
async def transcribe(audio: UploadFile = File(...), prompt: str = Form("")) -> dict:
    """Phase 1 of a voice turn: speech-to-text only. The client sends the transcript to /chat
    (phase 2) itself, so the user can see, and optionally edit, what was heard first."""
    data = await audio.read()
    filename = audio.filename or "recording.m4a"
    ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext not in GROQ_AUDIO_EXTS:
        log.warning("Audio extension %r from client is not in Groq's accepted list %s; the request may be rejected", ext, GROQ_AUDIO_EXTS)
    try:
        transcript = llm.transcribe(data, filename, prompt)
    except Exception as e:
        log.exception("transcribe failed")
        return {"transcript": "", "reply": "Sorry, I couldn't process the recording. Please try again.", "error": str(e)}
    # Whisper returns stray punctuation like "." for silence or noise; treat that as no speech.
    if not any(ch.isalnum() for ch in transcript):
        return {"transcript": "", "reply": "I didn't hear anything. Tap the button, speak, then tap again to send."}
    return {"transcript": transcript}


@app.get("/mission/{session_id}")
def get_mission(session_id: str) -> dict:
    with get_session() as db:
        view = mission_view(active_mission(db, session_id))
        return {"mission": view, "spoken": _spoken_step(view)}


@app.post("/mission/{session_id}/next")
def next_step(session_id: str, lat: Optional[float] = Form(None), lng: Optional[float] = Form(None)) -> dict:
    """Fast path for the 'Next step' button and GPS auto-advance; no LLM call."""
    with get_session() as db:
        m = active_mission(db, session_id)
        if m is None:
            return {"mission": None, "spoken": "There's no active mission."}
        result = _advance(ToolContext(db=db, session_id=session_id, lat=lat, lng=lng), m)
        if result.get("completed"):
            return {"mission": None, "spoken": f"That was the last step for {m.destination_name}. Let me know if you need help finding anything else."}
        view = mission_view(active_mission(db, session_id))
        return {"mission": view, "spoken": _spoken_step(view)}


@app.delete("/mission/{session_id}")
def cancel(session_id: str) -> dict:
    with get_session() as db:
        m = active_mission(db, session_id)
        if m:
            m.status = "cancelled"
            db.add(m)
            db.commit()
        return {"cancelled": m is not None}


@app.get("/observations/{session_id}")
def observations(session_id: str) -> list[dict]:
    with get_session() as db:
        rows = db.exec(select(Observation).where(Observation.session_id == session_id).order_by(Observation.created_at.desc())).all()
        return [r.model_dump(mode="json") for r in rows]


@app.delete("/observations/{session_id}/{obs_id}")
def delete_observation(session_id: str, obs_id: int) -> dict:
    with get_session() as db:
        row = db.get(Observation, obs_id)
        if row is None or row.session_id != session_id:
            raise HTTPException(404)
        db.delete(row)
        db.commit()
        return {"deleted": obs_id}


# ---------- maps: places and recorded routes ----------

class PlaceIn(BaseModel):
    name: str
    aliases: str = ""
    entrance: str = ""
    rooms: dict[str, str] = {}


class WaypointIn(BaseModel):
    lat: float
    lng: float
    heading: Optional[float] = None
    instruction: str = ""
    landmark_hint: str = ""


def _place_out(p: Place, wps: list[Waypoint]) -> dict:
    return {
        "id": p.id, "name": p.name, "aliases": p.aliases, "entrance": p.entrance,
        "rooms": json.loads(p.rooms_json or "{}"), "source": "recorded",
        "waypoints": [w.model_dump(mode="json") for w in sorted(wps, key=lambda w: w.seq)],
    }


@app.get("/places")
def list_places() -> list[dict]:
    with get_session() as db:
        places = db.exec(select(Place).order_by(Place.created_at.desc())).all()
        wps = db.exec(select(Waypoint)).all()
        out = [_place_out(p, [w for w in wps if w.place_id == p.id]) for p in places]
    # The sample campus.json destinations are read-only but shown so it's clear what exists.
    for d in CAMPUS["destinations"]:
        out.append({
            "id": None, "name": d["name"], "aliases": ", ".join(d["aliases"]), "entrance": d["entrance"],
            "rooms": d["rooms"], "source": "sample",
            "waypoints": [{"seq": i + 1, **s} for i, s in enumerate(d["route"])],
        })
    return out


@app.post("/places")
def create_place(body: PlaceIn) -> dict:
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Name is required.")
    with get_session() as db:
        p = Place(name=name, aliases=body.aliases, entrance=body.entrance, rooms_json=json.dumps(body.rooms))
        db.add(p)
        db.commit()
        db.refresh(p)
        return _place_out(p, [])


@app.patch("/places/{place_id}")
def update_place(place_id: int, body: PlaceIn) -> dict:
    with get_session() as db:
        p = db.get(Place, place_id)
        if p is None:
            raise HTTPException(404)
        p.name, p.aliases, p.entrance, p.rooms_json = body.name.strip() or p.name, body.aliases, body.entrance, json.dumps(body.rooms)
        db.add(p)
        db.commit()
        wps = db.exec(select(Waypoint).where(Waypoint.place_id == place_id)).all()
        return _place_out(p, wps)


@app.delete("/places/{place_id}")
def delete_place(place_id: int) -> dict:
    with get_session() as db:
        db.exec(delete(Waypoint).where(Waypoint.place_id == place_id))
        p = db.get(Place, place_id)
        if p:
            db.delete(p)
        db.commit()
        return {"deleted": place_id}


@app.post("/places/{place_id}/waypoints")
def add_waypoint(place_id: int, body: WaypointIn) -> dict:
    with get_session() as db:
        if db.get(Place, place_id) is None:
            raise HTTPException(404)
        last = db.exec(select(Waypoint).where(Waypoint.place_id == place_id).order_by(Waypoint.seq.desc())).first()
        w = Waypoint(place_id=place_id, seq=(last.seq + 1) if last else 1, **body.model_dump())
        db.add(w)
        db.commit()
        db.refresh(w)
        return w.model_dump(mode="json")


@app.delete("/waypoints/{waypoint_id}")
def delete_waypoint(waypoint_id: int) -> dict:
    with get_session() as db:
        w = db.get(Waypoint, waypoint_id)
        if w:
            db.delete(w)
            db.commit()
        return {"deleted": waypoint_id}


@app.delete("/memory/{session_id}")
def forget_everything(session_id: str) -> dict:
    with get_session() as db:
        for model in (Observation, Preference, Message, Mission):
            db.exec(delete(model).where(model.session_id == session_id))
        db.commit()
        return {"deleted": True}
