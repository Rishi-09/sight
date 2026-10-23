import { File, Paths } from 'expo-file-system';

export type Settings = {
  wakeName: string; // what the user calls the assistant ("Sight", "Buddy", ...)
  handsFree: boolean;
  wakeWord: boolean; // require the name before a request
  reviewFirst: boolean;
};

export const DEFAULT_SETTINGS: Settings = { wakeName: 'Sight', handsFree: true, wakeWord: true, reviewFirst: false };

const file = () => new File(Paths.document, 'sight-settings.json');

export function loadSettings(): Settings {
  try {
    const f = file();
    if (!f.exists) return DEFAULT_SETTINGS;
    const { wakeName, handsFree, wakeWord, reviewFirst } = { ...DEFAULT_SETTINGS, ...JSON.parse(f.textSync()) };
    return { wakeName, handsFree, wakeWord, reviewFirst }; // drops keys from older versions
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: Settings) {
  try {
    const f = file();
    if (!f.exists) f.create();
    f.write(JSON.stringify(s));
  } catch (e) {
    console.error('[SIGHT] could not save settings', e);
  }
}

// Names that would trigger constantly or clash with commands.
const BLOCKED = new Set(['the', 'a', 'an', 'stop', 'yes', 'no', 'ok', 'okay', 'hey', 'hi', 'hello', 'live', 'repeat', 'next', 'go', 'back', 'menu']);

/** Cleans a requested name, or returns null if it isn't usable as a wake word. */
export function validWakeName(raw: string): string | null {
  const name = raw.replace(/[^a-zA-Z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (name.length < 3 || name.length > 20 || name.split(' ').length > 2) return null;
  if (BLOCKED.has(name.toLowerCase())) return null;
  return name
    .split(' ')
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}
