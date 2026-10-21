# SIGHT: hackathon MVP

A voice-first agent for blind and low-vision users. You state a goal and SIGHT works out which of its abilities to use: describing the camera view, reading text, remembering where your belongings are, or guiding you on a campus route. The spec is in [CLAUDE.md](CLAUDE.md).

```
backend/   FastAPI + Groq agent with whitelisted tools, SQLite (or TiDB Cloud / MySQL)
mobile/    Expo (React Native) app: camera, voice, GPS, TTS
```

## Run it

**1. Backend** (laptop)
```bash
cd backend
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt   # macOS/Linux: .venv/bin/pip
cp .env.example .env        # paste a free key from https://console.groq.com/keys
.venv/Scripts/uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```
By default this uses a local `sight.db` SQLite file. To point at a cloud MySQL/TiDB database instead, set `DB_HOST` (and `DB_PORT`/`DB_USERNAME`/`DB_PASSWORD`/`DB_DATABASE`) in `.env` — see the comments there, especially the note about TiDB Cloud's Public vs Private Endpoint connection types.
Check: `curl -F text="what destinations do you know" http://localhost:8000/chat`

**2. Mobile** (Android phone with **Expo Go**, on the same Wi-Fi as the laptop)
```bash
cd mobile
cp .env.example .env        # set your laptop's LAN IP (ipconfig → IPv4 Address)
npx expo start
```
Scan the QR code with Expo Go. If Windows Firewall prompts, allow Python on private networks.

**Deploying the backend** (so other phones can reach it): see [docs/DEPLOY.md](docs/DEPLOY.md). It covers Docker, a Render blueprint, Railway, Fly.io and a quick tunnel.

**3. Your campus.** Edit [backend/app/campus.json](backend/app/campus.json). The current data is a sample. Walk your real route once and record a GPS point at each turn (Google Maps → long-press → copy the coordinates).

## How it works
- **Hands-free by default:** the app listens continuously, detects when someone starts and stops speaking from the microphone level, and only acts on requests that start with the wake word **"Sight"** (e.g. "Sight, start live"). For ~8 s after it answers, a follow-up needs no wake word. It never listens while it's talking. Short commands ("stop live", "repeat", "next step", "open maps", "go back") run instantly on the phone; anything else goes to the agent, which can also operate the app through its `control_app` tool. Every screen announces itself and reads its contents aloud.
- A voice turn has **two phases**. The **Talk** button records audio (`.m4a`); tapping it again uploads the audio to `/transcribe`, where Groq's Whisper turns it into text. The app then sends that text, one camera frame, and your GPS position to `/chat`, exactly as if you had typed it. With **Review before sending** on, the transcript lands in the text box instead, so you can edit it and press **Send**.
- **Live mode** (the **Live** button) sends a small camera frame about every 2.5 s to `/live/frame`. The vision model compares it against what it saw last, and the server only returns something to say for **hazards** (repeated at most every 20 s) or **meaningful changes** (at most every 8 s), so the user isn't flooded with audio. Live pauses while you're talking to SIGHT, and its latest view is passed to the agent as context. 
- **Multiple AI providers with failover** ([llm.py](backend/app/llm.py)): Groq and OpenRouter are both used through one OpenAI-compatible client. A provider that rate-limits, errors or misses an 8 s live deadline goes on a cooldown (as long as it asks for) and requests move to the next one. Live frames alternate between providers to double the per-minute budget. `/health` shows each provider's calls, failures and cooldown. The agent's history is trimmed to a size budget and large tool results are capped, so every request fits any provider's free-tier limits. `VISION_PROVIDER=ollama` switches vision to the laptop GPU instead. See [docs/PLAN.md](docs/PLAN.md) for the full live-video and maps roadmap.
- `/chat` runs a **function-calling loop** ([agent.py](backend/app/agent.py)) on a Groq text model. Camera frames are analyzed separately by a vision-capable Llama model ([llm.py](backend/app/llm.py)). The agent model can only call the tools in [tools.py](backend/app/tools.py) and has no other access to the phone or the data.
- Every request includes the **active mission and user preferences**. That is why "where's the entrance?" partway through a route works without explaining the context again.
- Vision answers come back with a `confidence` level. When confidence is low, the phone gives a warning vibration and SIGHT says it isn't sure.
- **Next step** and GPS auto-advance (within 15 m of the next waypoint) use a fast endpoint that doesn't call the LLM.
- The **Memory** screen shows every saved belonging and can delete it, or delete everything.

## Demo script (Mission Mode)
1. "What's in front of me?" → describes the scene (Demo 1)
2. *(Camera on a bag)* "I'm leaving my black backpack under this desk." → saved observation
3. "Help me get to the computer science department, room CS-204." → SIGHT confirms → "Yes" → mission starts and step 1 is spoken
4. Walk, or tap **Next step**, through the route; each step's landmark hint is spoken
5. At the building: "Where's the entrance?" → camera plus the expected entrance description
6. "How do I get to my room from here?" → room directions, using the mission context
7. "Where did I leave my backpack?" → last recorded location, the time recorded, and a note that it may have moved (Demo 2)

The text box is a fallback if the room is too noisy for speech recognition. Record a backup video of a full run before demo day.

## Known limits (be upfront about these with judges)
- Routes are predefined waypoints. They are not live turn-by-turn routing, and GPS can be off by 5–20 m.
- "Arrived" means the user worked through the steps. The app has not verified their position.
- This is not an obstacle detector and does not replace a cane or guide dog.
- The free Groq tier has rate limits. Avoid rapid-fire requests during the demo.
