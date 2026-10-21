"""Model access for SIGHT, routed across several OpenAI-compatible providers.

Groq and OpenRouter both speak the OpenAI chat-completions API, so one client type covers both.
Each provider gets a cooldown when it rate-limits or fails, and requests move to the next
provider instead of waiting. Live frames rotate across providers to spread the per-minute
token budgets; the agent keeps a fixed preference order so a conversation stays on one model
when possible.
"""

import base64
import concurrent.futures as cf
import itertools
import json
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Literal, Optional

import httpx
from openai import APIConnectionError, APIStatusError, APITimeoutError, OpenAI, RateLimitError

# Whisper is only on Groq, so speech-to-text always uses it.
STT_MODEL = os.getenv("GROQ_STT_MODEL", "whisper-large-v3-turbo")

# Optional local vision (Ollama on the laptop GPU): no quota, frames never leave the machine.
VISION_PROVIDER = os.getenv("VISION_PROVIDER", "cloud").lower()  # "cloud" or "ollama"
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
OLLAMA_VISION_MODEL = os.getenv("OLLAMA_VISION_MODEL", "qwen3.5:4b")

Kind = Literal["text", "vision"]


@dataclass
class Provider:
    name: str
    client: OpenAI
    text_model: str
    vision_model: str
    extra_body: dict = field(default_factory=dict)
    vision_extra_body: dict = field(default_factory=dict)  # merged in for vision calls only
    cooldown_until: float = 0.0
    last_error: str = ""
    calls: int = 0
    failures: int = 0

    def model(self, kind: Kind) -> str:
        return self.vision_model if kind == "vision" else self.text_model

    def cool_down(self, seconds: float, error: str) -> None:
        self.cooldown_until = max(self.cooldown_until, time.time() + seconds)
        self.last_error = error[:200]
        self.failures += 1


class AllProvidersBusy(Exception):
    """Every provider is cooling down. retry_after is when the soonest one is usable again."""

    def __init__(self, retry_after: float, last_error: str = ""):
        super().__init__(f"All AI providers are busy; retry in {retry_after:.0f}s. Last error: {last_error}")
        self.retry_after = retry_after


_providers: Optional[list[Provider]] = None
_lock = threading.Lock()
_rotation = itertools.count()
# Calls run on a pool so each one gets a wall-clock deadline. The SDK's own timeout is reset by
# every byte received, and OpenRouter sends keep-alive bytes while it waits upstream, so a
# "timeout=8" call was observed taking 57 s. A timed-out call is abandoned, not cancelled.
_pool = cf.ThreadPoolExecutor(max_workers=8, thread_name_prefix="llm")


def providers() -> list[Provider]:
    """Built lazily so the .env loaded in app/__init__.py is in place."""
    global _providers
    with _lock:
        if _providers is None:
            found: dict[str, Provider] = {}
            if os.getenv("GROQ_API_KEY"):
                found["groq"] = Provider(
                    "groq",
                    OpenAI(api_key=os.environ["GROQ_API_KEY"], base_url="https://api.groq.com/openai/v1", max_retries=0),
                    os.getenv("GROQ_MODEL", "openai/gpt-oss-120b"),
                    os.getenv("GROQ_VISION_MODEL", "qwen/qwen3.8-27b"),
                )
            if os.getenv("OPENROUTER_API_KEY"):
                found["openrouter"] = Provider(
                    "openrouter",
                    OpenAI(
                        api_key=os.environ["OPENROUTER_API_KEY"],
                        base_url="https://openrouter.ai/api/v1",
                        max_retries=0,
                        default_headers={"X-Title": "SIGHT"},
                    ),
                    os.getenv("OPENROUTER_MODEL", "openai/gpt-oss-120b"),
                    os.getenv("OPENROUTER_VISION_MODEL", "qwen/qwen3.8-27b"),
                    # By default OpenRouter may route to a slow host (measured 4-57 s for the same
                    # model); sorting by latency gave a steady ~2 s.
                    extra_body={"provider": {"sort": "latency"}},
                    # Qwen on OpenRouter "thinks" first; that sometimes used the whole token budget
                    # and returned an empty answer. Describing a frame doesn't need it (and it's faster).
                    vision_extra_body={"reasoning": {"enabled": False}},
                )
            order = [n.strip() for n in os.getenv("PROVIDER_ORDER", "groq,openrouter").split(",")]
            _providers = [found[n] for n in order if n in found] + [p for n, p in found.items() if n not in order]
        return _providers


def status() -> list[dict]:
    now = time.time()
    return [
        {
            "name": p.name,
            "text_model": p.text_model,
            "vision_model": p.vision_model,
            "ready": p.cooldown_until <= now,
            "cooldown_s": max(0, round(p.cooldown_until - now, 1)),
            "calls": p.calls,
            "failures": p.failures,
            "last_error": p.last_error,
        }
        for p in providers()
    ]


def _retry_after(e: APIStatusError, default: float) -> float:
    try:
        return min(max(float(e.response.headers.get("retry-after", default)), 1.0), 60.0)
    except (TypeError, ValueError):
        return default


def complete(kind: Kind, messages: list, *, fast: bool = False, rotate: bool = False, **kwargs):
    """Chat completion with failover. Returns (response, provider_name).

    fast:   live-mode frames. Short timeout, and no waiting when everything is busy.
    rotate: spread calls across providers round-robin instead of always preferring the first.
    """
    ps = providers()
    if not ps:
        raise RuntimeError("No AI provider key set. Add GROQ_API_KEY and/or OPENROUTER_API_KEY to backend/.env.")

    for attempt in range(2):
        now = time.time()
        ready = [p for p in ps if p.cooldown_until <= now]
        if rotate and len(ready) > 1:
            start = next(_rotation) % len(ready)
            ready = ready[start:] + ready[:start]

        last_error = ""
        deadline = 8 if fast else 45
        for p in ready:
            try:
                p.calls += 1
                extra = {**p.extra_body, **(p.vision_extra_body if kind == "vision" else {})}
                future = _pool.submit(
                    p.client.with_options(timeout=deadline).chat.completions.create,
                    model=p.model(kind),
                    messages=messages,
                    extra_body=extra or None,
                    **kwargs,
                )
                resp = future.result(timeout=deadline)
                msg = resp.choices[0].message if resp.choices else None
                if msg is None or not (msg.content or "").strip() and not msg.tool_calls:
                    # An empty answer is a failure, not "nothing to say": try the next provider.
                    p.cool_down(3, "empty response")
                    last_error = p.last_error
                    continue
                return resp, p.name
            except cf.TimeoutError:
                p.cool_down(10, f"no response within {deadline}s")
            except RateLimitError as e:
                p.cool_down(_retry_after(e, 20), f"rate limited: {e}")
            except (APITimeoutError, APIConnectionError) as e:
                p.cool_down(5, f"{type(e).__name__}: {e}")
            except APIStatusError as e:
                # 402 no credits, 401 bad key, 404 model retired: long cooldown. 5xx: short.
                # 400s can be provider-specific (an unsupported parameter), so fail over too.
                seconds = 300 if e.status_code in (401, 402, 403, 404) else 10 if e.status_code >= 500 else 30
                p.cool_down(seconds, f"HTTP {e.status_code}: {e}")
            last_error = p.last_error

        wait = max(0.5, min(p.cooldown_until for p in ps) - time.time())
        # The agent can afford a short wait for the soonest provider; live frames can't.
        if fast or attempt == 1 or wait > 12:
            raise AllProvidersBusy(wait, last_error)
        time.sleep(wait)
    raise AllProvidersBusy(1.0)


# ---------- vision ----------

VISION_RULES = (
    "You are the eyes for a blind or low-vision person. Be concrete and brief. "
    "Use clock-face directions (e.g. 'at 2 o'clock') and rough distances in steps or metres. "
    "Only describe what is actually visible. If the image is blurry, dark, or the thing asked about is "
    "not clearly visible, say so and set confidence to low. "
    "Never claim a path is safe to walk; you can mention visible obstacles.\n\n"
    "Reply with ONLY a JSON object, no other text, in this exact shape: "
    '{"answer": "1-3 short spoken sentences", "confidence": "high" | "medium" | "low", '
    '"visible_text": "any legible text in the image, or empty string"}'
)


def _vision_ollama(system: str, prompt: str, b64: str) -> str:
    resp = httpx.post(
        f"{OLLAMA_URL}/api/chat",
        json={
            "model": OLLAMA_VISION_MODEL,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt, "images": [b64]},
            ],
            "format": "json",
            "stream": False,
            "think": False,  # skip hidden reasoning on thinking-capable models; latency matters more
            "keep_alive": "30m",  # keep the model loaded in VRAM between live frames
            "options": {"temperature": 0.2},
        },
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()["message"]["content"]


def vision_json(system: str, prompt: str, image: bytes, mime: str = "image/jpeg", fast: bool = False) -> dict:
    """Ask a vision model about one image; the system prompt must request a JSON object.
    fast=True (live mode): short timeout, rotate providers, raise AllProvidersBusy rather than wait."""
    b64 = base64.b64encode(image).decode("ascii")
    if VISION_PROVIDER == "ollama":
        text, provider = _vision_ollama(system, prompt, b64), "ollama"
    else:
        resp, provider = complete(
            "vision",
            [
                {"role": "system", "content": system},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
                    ],
                },
            ],
            fast=fast,
            rotate=fast,
            response_format={"type": "json_object"},
            temperature=0.2,
            max_tokens=300,
        )
        text = resp.choices[0].message.content or ""
    text = text.strip()
    try:
        data = json.loads(text)
        data = data if isinstance(data, dict) else {"answer": text}
    except json.JSONDecodeError:
        data = {"answer": text}
    data["_provider"] = provider
    return data


def vision(question: str, image: bytes, mime: str = "image/jpeg") -> dict:
    data = vision_json(VISION_RULES, question, image, mime)
    data.pop("_provider", None)
    data.setdefault("confidence", "low")
    data.setdefault("answer", "I couldn't interpret the image.")
    return data


# ---------- speech-to-text ----------

def transcribe(audio: bytes, filename: str, prompt: str = "") -> str:
    # Groq's Whisper endpoint only accepts these container/extensions: flac, mp3, mp4,
    # mpeg, mpga, m4a, ogg, wav, webm (no raw .aac/.3gp) - the mobile app records .m4a.
    # `prompt` biases Whisper's vocabulary: passing the wake word ("Sight, ...") makes it far
    # more likely to be transcribed as that word instead of "site" or "side".
    groq = next((p for p in providers() if p.name == "groq"), None)
    if groq is None:
        raise RuntimeError("Speech-to-text needs GROQ_API_KEY (Whisper is only available on Groq).")
    kwargs = {"prompt": prompt[:400]} if prompt else {}
    resp = groq.client.with_options(max_retries=1, timeout=30).audio.transcriptions.create(
        model=STT_MODEL, file=(filename, audio), **kwargs
    )
    return (resp.text or "").strip()
