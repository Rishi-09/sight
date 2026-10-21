import json
import os
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import quote_plus

import certifi
from sqlalchemy import Column, Text
from sqlmodel import Field, Session, SQLModel, create_engine, select


def _build_database_url() -> str:
    """Prefer a TiDB/MySQL cloud DB (DB_HOST and friends) over DATABASE_URL/sqlite."""
    host = os.getenv("DB_HOST")
    if not host:
        return os.getenv("DATABASE_URL", "sqlite:///sight.db")
    port = os.getenv("DB_PORT", "4000")
    user = quote_plus(os.getenv("DB_USERNAME", ""))
    password = quote_plus(os.getenv("DB_PASSWORD", ""))
    database = os.getenv("DB_DATABASE", "sight")
    if database == "sys":
        # 'sys' is TiDB/MySQL's reserved system schema, not meant for app tables.
        database = "sight"
    return f"mysql+pymysql://{user}:{password}@{host}:{port}/{database}"


DATABASE_URL = _build_database_url()

if DATABASE_URL.startswith("sqlite"):
    _connect_args = {"check_same_thread": False}
    _engine_kwargs = {}
elif DATABASE_URL.startswith("mysql"):
    # TiDB Cloud requires TLS. certifi's CA bundle verifies the standard public CA chain;
    # pool_recycle avoids using connections the cloud DB has silently dropped while idle.
    _connect_args = {"ssl": {"ca": certifi.where()}}
    _engine_kwargs = {"pool_pre_ping": True, "pool_recycle": 280}
else:
    _connect_args = {}
    _engine_kwargs = {}

engine = create_engine(DATABASE_URL, connect_args=_connect_args, **_engine_kwargs)


def now() -> datetime:
    return datetime.now(timezone.utc)


class Mission(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    session_id: str = Field(index=True)
    destination_id: str
    destination_name: str
    # TEXT, not the SQLModel/MySQL default VARCHAR(255): this JSON blob (route + entrance +
    # room steps) regularly exceeds 255 chars and SQLite doesn't enforce the limit, so this
    # only breaks once pointed at a real MySQL-family DB.
    steps_json: str = Field(sa_column=Column(Text))  # list of {kind, instruction, lat?, lng?, landmark_hint?}
    current_step: int = 0
    status: str = "active"  # active | completed | cancelled
    created_at: datetime = Field(default_factory=now)

    @property
    def steps(self) -> list[dict]:
        return json.loads(self.steps_json)


class Observation(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    session_id: str = Field(index=True)
    object_name: str
    location_note: str = Field(sa_column=Column(Text))
    scene_description: str = Field(default="", sa_column=Column(Text))
    lat: Optional[float] = None
    lng: Optional[float] = None
    created_at: datetime = Field(default_factory=now)


class Preference(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    session_id: str = Field(index=True)
    key: str
    value: str


class Message(SQLModel, table=True):
    """Short text-only conversation history so follow-up questions keep context."""

    id: Optional[int] = Field(default=None, primary_key=True)
    session_id: str = Field(index=True)
    role: str  # user | assistant
    text: str = Field(sa_column=Column(Text))
    created_at: datetime = Field(default_factory=now)


class Place(SQLModel, table=True):
    """A destination recorded in the app's Maps screen (complements the sample campus.json)."""

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    aliases: str = ""  # comma-separated alternative names
    entrance: str = Field(default="", sa_column=Column(Text))
    rooms_json: str = Field(default="{}", sa_column=Column(Text))  # {"CS-204": "directions..."}
    created_at: datetime = Field(default_factory=now)


class Waypoint(SQLModel, table=True):
    """One recorded point along the route to a Place, in walking order."""

    id: Optional[int] = Field(default=None, primary_key=True)
    place_id: int = Field(index=True)
    seq: int
    lat: float
    lng: float
    heading: Optional[float] = None  # compass heading the recorder was facing, degrees
    instruction: str = Field(default="", sa_column=Column(Text))
    landmark_hint: str = Field(default="", sa_column=Column(Text))
    created_at: datetime = Field(default_factory=now)


def init_db() -> None:
    SQLModel.metadata.create_all(engine)


def get_session() -> Session:
    return Session(engine)


def active_mission(db: Session, session_id: str) -> Optional[Mission]:
    return db.exec(
        select(Mission)
        .where(Mission.session_id == session_id, Mission.status == "active")
        .order_by(Mission.id.desc())
    ).first()


def mission_view(m: Optional[Mission]) -> Optional[dict]:
    if m is None:
        return None
    steps = m.steps
    idx = min(m.current_step, len(steps) - 1)
    return {
        "id": m.id,
        "destination": m.destination_name,
        "status": m.status,
        "current_step": m.current_step,
        "total_steps": len(steps),
        "step": steps[idx] if m.status == "active" else None,
        "steps": steps,
    }
