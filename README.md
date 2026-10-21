# SIGHT: A Voice Assistant for Blind and Low-Vision People

SIGHT is an Android app you **talk to**. It looks through the phone's camera, describes what's in front of you, reads text aloud, remembers where you left things, and can keep watching and warn you about what's ahead. Everything works by voice, so you never need to see the screen.

This is a **hackathon prototype**. The basic features below are ready to test; a few others are only boilerplate (see [What's still rough](#whats-still-rough)).

---

## Get started (one step)

**[Download SIGHT App from Google Drive](https://drive.google.com/drive/folders/1bsV8ustJUwAHJBuE8-2p-35vB18kRC4V?usp=sharing)**

Install it on an **Android** phone, **allow all the permissions** (camera, microphone, location), and start exploring.

That's all. The server is already deployed online, so there is nothing else to set up.

- **If you see "your phone currently isn't allowed to install unknown apps from this source":**
  1. Tap **Settings** on that message.
  2. Turn on **Allow from this source** (it names the app you're installing from, e.g. Drive or Chrome).
  3. Go back and tap the app file again. It will install.
- If **Play Protect** warns about an unknown app, review the warning carefully before deciding whether to proceed.
- Apps installed outside the Play Store may trigger these warnings.
- **Turn the volume up.** SIGHT speaks all its answers and introduces itself when it opens.
- The first request after a quiet period may rarely take **30–60 seconds** (the free server wakes up). After that, answers take a few seconds.

---

## Features you can test now

Start each request with the name **"Sight"**, then wait for it to finish speaking before you talk. After it answers, you can follow up for about 8 seconds without saying "Sight" again. If it doesn't hear you, tap **Talk** (bottom-left) and speak straight away.

| Feature | Say this |
|---|---|
| **Describe what's in front of you** | "Sight, what's in front of me?" |
| **Ask about the scene** | "Sight, where is the door?" |
| **Read text aloud** | "Sight, read this." (point at a sign, label or page) |
| **Go live** | "Sight, start live." It describes the scene straight away, then speaks only when something changes or there's a possible hazard. |
| **Stop live** | "Sight, stop live." (or tap **Live**, bottom-right) |
| **Repeat** | "Sight, repeat." (or tap **Repeat**, top-left) |
| **Remember something** | "Sight, I'm leaving my keys on the desk." |
| **Find it again** | "Sight, where are my keys?" |
| **See what it remembers** | "Sight, open memory." / "Sight, go back." |
| **Change its name** | "Sight, change your name to Buddy." Then say "Buddy, start live", and so on. |

**Tips:** Use a fairly quiet room, hold the phone at chest height with the back camera facing forward, and speak clearly.

### The screen: four corners, easy to find by touch

| Screen position | Control |
|---|---|
| Top-left | **Repeat** |
| Top-right | **Agent panel**: shows what it heard and answered; tap for the Menu |
| Bottom-left | **Talk** |
| Bottom-right | **Live** on/off |

The camera view is in the centre.

---

## What's still rough

Some features are **boilerplate**. The structure is there and you can try them, but they need a lot more refinement and building before real use:

- **Campus navigation** ("Sight, take me to the library"): follows a fixed list of steps using **sample campus data**. GPS can be off by 5–20 m, and it can't confirm that you've arrived.
- **Maps screen and route recording:** You can create places and record route points ("Sight, create a place called Hostel", then "Sight, add a point here, turn right at the gate"), but it is very basic.
- **Live mode** looks about every 5 seconds, not continuously. It can miss things and is **not an obstacle detector**.
- **The wake word** can miss in noisy rooms. Use the Talk button then.
- It **can't be interrupted** while speaking, and **Hindi** is untested.
- The AI service is shared and rate-limited. If it's busy, you'll hear "One moment…" while it waits.

> ⚠️ **Safety:** SIGHT is a prototype. It does not replace a white cane, guide dog or a person's own judgement, and shouldn't be relied on to cross roads or avoid obstacles.

---

## Troubleshooting

| Problem | Try this |
|---|---|
| Top-right panel says **"Server unreachable"** | Check the phone's internet, wait up to a minute for the server to wake up, then close and reopen the app. |
| It doesn't respond to "Sight" | Tap **Talk** (bottom-left) and speak, or type in the Menu. |
| No sound | Turn up the media volume. The phone needs a text-to-speech engine (Google's comes with most Android phones). |
| Two voices at once | Turn off Android's **TalkBack** while using SIGHT. |

---

<details>
<summary><b>For developers</b></summary>

### Project structure

```text
backend/   FastAPI server: speech-to-text, AI agent with tools, live vision, maps (deployed on Render)
mobile/    Expo / React Native Android app
```

### Backend locally

Navigate to the backend directory:

```bash
cd backend
```

Create a Python virtual environment:

```bash
python -m venv .venv
```

Activate the environment.

**Windows:**

```powershell
.venv\Scripts\activate
```

**Linux/macOS:**

```bash
source .venv/bin/activate
```

Install the dependencies:

```bash
pip install -r requirements.txt
```

Copy `.env.example` to `.env` and fill in the required keys.

**Windows:**

```powershell
copy .env.example .env
```

**Linux/macOS:**

```bash
cp .env.example .env
```

Start the development server:

```bash
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### Deploying the backend

The backend uses the following deployment configuration:

- `backend/Dockerfile`
- `render.yaml`

The backend is deployed on Render.

Configure the required environment variables in the Render dashboard before deploying.

### Mobile app

Navigate to the mobile directory:

```bash
cd mobile
```

Install dependencies:

```bash
npm install
```

Set `EXPO_PUBLIC_API_URL` in `mobile/.env` to your backend URL:

```env
EXPO_PUBLIC_API_URL=https://your-backend-url
```

Start the development server:

```bash
npx expo start
```

### Build the Android APK

Run these commands from the `mobile` directory:

```bash
npm run prebuild
npm run apk
```

To install the APK on a connected Android device:

```bash
npm run apk:install
```

</details>

---

## GitHub Repository

**Source code:** [https://github.com/Rishi-09/sight/](https://github.com/Rishi-09/sight/)

Explore the repository to view the source code and follow the development of SIGHT.

---

<p align="center">
  Built with the goal of making everyday experiences more accessible for blind and low-vision people.
</p>
