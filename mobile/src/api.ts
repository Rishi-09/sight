import { File, Paths } from 'expo-file-system';

// Set EXPO_PUBLIC_API_URL in mobile/.env; it's baked into the app at build time. For local
// development over USB (`npm run usb`) use http://localhost:8000. The fallback is the deployed
// backend, so a build that misses the variable still works on other people's phones.
export const API_URL = process.env.EXPO_PUBLIC_API_URL || 'https://sight-blh6.onrender.com';

// One random ID per installation, saved on the phone, so each user has their own memory,
// missions, conversation and live-mode state on the shared server.
function loadOrCreateSessionId(): string {
  const f = new File(Paths.document, 'sight-session-id.txt');
  try {
    if (f.exists) {
      const saved = f.textSync().trim();
      if (saved) return saved;
    }
  } catch {}
  const id = `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    if (!f.exists) f.create();
    f.write(id);
  } catch (e) {
    console.error('[SIGHT] could not save session id', e);
  }
  return id;
}
export const SESSION_ID = loadOrCreateSessionId();

export type Step = {
  kind: 'walk' | 'entrance' | 'room';
  instruction: string;
  lat?: number;
  lng?: number;
  landmark_hint?: string;
};

export type Mission = {
  id: number;
  destination: string;
  status: string;
  current_step: number;
  total_steps: number;
  step: Step | null;
  steps: Step[];
};

// Phone-side actions the agent can request (mirrors APP_ACTIONS in backend/app/tools.py).
export type AppAction =
  | 'live_on'
  | 'live_off'
  | 'repeat'
  | 'stop_speaking'
  | 'next_step'
  | 'open_maps'
  | 'open_memory'
  | 'open_menu'
  | 'go_home'
  | 'review_on'
  | 'review_off'
  | `set_wake_word:${string}`;

export type AgentResponse = {
  reply: string;
  actions?: AppAction[];
  busy_retry_after?: number; // AI was busy or failed: worth one automatic retry after this many seconds
  confidence?: 'high' | 'medium' | 'low' | null;
  mission?: Mission | null;
  error?: string;
};

export type Observation = {
  id: number;
  object_name: string;
  location_note: string;
  scene_description: string;
  created_at: string;
};

export type Coords = { lat: number; lng: number } | null;

export type TranscribeResponse = { transcript: string; reply?: string; error?: string };

export type LiveFrameResponse = {
  speak: string;
  hazard: boolean;
  reason: string;
  summary?: string;
  latency_s?: number;
  backoff_s?: number; // server is rate limited: wait this long before the next frame
  // reason: 'first' (opening description), 'hazard', 'change', 'unclear', 'quiet', 'busy', ...
  error?: string;
};

// Expo SDK 57 replaces global fetch with expo/fetch, which rejects React Native's
// `{ uri, name, type }` FormData parts ("Unsupported FormDataPart implementation").
// It accepts Blob-like objects, and expo-file-system's File implements Blob.
function filePart(uri: string) {
  return new File(uri) as unknown as Blob;
}

async function postForm<T>(path: string, form: FormData, timeoutMs = 45000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_URL}${path}`, { method: 'POST', body: form, signal: controller.signal });
    if (!res.ok) throw new Error(`Server error ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function baseForm(imageUri: string | null, coords: Coords) {
  const form = new FormData();
  form.append('session_id', SESSION_ID);
  if (imageUri) form.append('image', filePart(imageUri));
  if (coords) {
    form.append('lat', String(coords.lat));
    form.append('lng', String(coords.lng));
  }
  return form;
}

// Phase 1: speech-to-text only. The transcript then goes through sendText like typed input.
// prompt biases Whisper's vocabulary (e.g. toward the wake word).
export function transcribe(audioUri: string, prompt = '') {
  const form = new FormData();
  form.append('audio', filePart(audioUri));
  if (prompt) form.append('prompt', prompt);
  return postForm<TranscribeResponse>('/transcribe', form, 30000);
}

// Live mode: one frame at a time; the server decides whether anything is worth saying.
export function sendLiveFrame(imageUri: string) {
  const form = new FormData();
  form.append('session_id', SESSION_ID);
  form.append('image', filePart(imageUri));
  return postForm<LiveFrameResponse>('/live/frame', form, 20000);
}

export async function stopLive() {
  await fetch(`${API_URL}/live/${SESSION_ID}`, { method: 'DELETE' });
}

export function sendText(text: string, imageUri: string | null, coords: Coords, heading?: number | null) {
  const form = baseForm(imageUri, coords);
  form.append('text', text);
  if (heading != null) form.append('heading', String(heading));
  return postForm<AgentResponse>('/chat', form);
}

export function nextStep(coords: Coords) {
  return postForm<{ mission: Mission | null; spoken: string }>(`/mission/${SESSION_ID}/next`, baseForm(null, coords));
}

export async function checkHealth(): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${API_URL}/health`, { signal: controller.signal });
    if (!res.ok) throw new Error(`Server error ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function getMission(): Promise<{ mission: Mission | null; spoken: string }> {
  return (await fetch(`${API_URL}/mission/${SESSION_ID}`)).json();
}

export async function listObservations(): Promise<Observation[]> {
  return (await fetch(`${API_URL}/observations/${SESSION_ID}`)).json();
}

export async function deleteObservation(id: number) {
  await fetch(`${API_URL}/observations/${SESSION_ID}/${id}`, { method: 'DELETE' });
}

// ---------- maps ----------

export type Waypoint = {
  id?: number;
  seq: number;
  lat: number;
  lng: number;
  heading?: number | null;
  instruction: string;
  landmark_hint?: string;
};

export type Place = {
  id: number | null; // null for read-only sample destinations
  name: string;
  aliases: string;
  entrance: string;
  rooms: Record<string, string>;
  source: 'recorded' | 'sample';
  waypoints: Waypoint[];
};

async function json<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Server error ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export const listPlaces = () => json<Place[]>('/places');
export const createPlace = (p: { name: string; aliases?: string; entrance?: string; rooms?: Record<string, string> }) =>
  json<Place>('/places', 'POST', p);
export const updatePlace = (id: number, p: { name: string; aliases: string; entrance: string; rooms: Record<string, string> }) =>
  json<Place>(`/places/${id}`, 'PATCH', p);
export const deletePlace = (id: number) => json(`/places/${id}`, 'DELETE');
export const addWaypoint = (placeId: number, w: Omit<Waypoint, 'id' | 'seq'>) =>
  json<Waypoint>(`/places/${placeId}/waypoints`, 'POST', w);
export const deleteWaypoint = (id: number) => json(`/waypoints/${id}`, 'DELETE');

export async function forgetEverything() {
  await fetch(`${API_URL}/memory/${SESSION_ID}`, { method: 'DELETE' });
}
