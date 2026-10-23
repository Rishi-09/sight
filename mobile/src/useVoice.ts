import { useCallback, useEffect } from 'react';
import {
  RecordingOptions,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import * as Speech from 'expo-speech';

// .m4a (AAC-in-MP4) is one of the few containers Groq's Whisper endpoint accepts;
// it's also the HIGH_QUALITY preset's default on both Android ('mpeg4'+'aac') and iOS,
// so we only need to trim the bitrate/channels for smaller voice-command uploads.
// Metering gives a live input level, which hands-free mode uses to detect speech.
const OPTIONS: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 64000,
  isMeteringEnabled: true,
};

// Voice-activity detection, tuned for a phone held at chest height. Levels are dBFS (0 = loudest).
const POLL_MS = 100;
const CALIBRATE_MS = 500; // first listen only: the average level here becomes the noise floor
const SPEECH_ABOVE_FLOOR_DB = 12;
const MIN_SPEECH_THRESHOLD_DB = -48;
const END_SILENCE_MS = 900; // this much quiet after speech ends the utterance
const MIN_SPEECH_MS = 300; // shorter bursts (a cough, a door) are ignored
const MAX_UTTERANCE_MS = 15000;
const MAX_IDLE_MS = 10000; // restart a silent recording so files stay small

// The noise floor persists between listens. Re-measuring it at the start of every listen meant
// that if the user started talking straight away, their own voice became the "floor", and the
// wake word was missed.
let noiseFloor: number | null = null;

export type ListenOptions = {
  shouldAbort: () => boolean;
  isSpeaking?: () => boolean; // SIGHT is talking: ignore the mic until it stops
};

export type ListenResult = { uri: string } | { uri: null; reason: 'aborted' | 'no_speech' | 'tts_ended' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function useVoice() {
  const recorder = useAudioRecorder(OPTIONS);
  const state = useAudioRecorderState(recorder, 200);

  useEffect(() => {
    (async () => {
      await requestRecordingPermissionsAsync();
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    })();
  }, []);

  const start = useCallback(async () => {
    Speech.stop();
    await recorder.prepareToRecordAsync();
    recorder.record();
  }, [recorder]);

  const stop = useCallback(async (): Promise<string | null> => {
    await recorder.stop();
    return recorder.uri;
  }, [recorder]);

  /**
   * Record until someone speaks and then stops (no button needed).
   * While SIGHT is talking the mic is ignored (it would only hear SIGHT itself), and the recording
   * restarts cleanly once SIGHT goes quiet, so the file never contains its voice.
   */
  const listen = useCallback(
    async ({ shouldAbort, isSpeaking = () => false }: ListenOptions): Promise<ListenResult> => {
      await recorder.prepareToRecordAsync();
      recorder.record();
      const t0 = Date.now();
      const calib: number[] = [];
      let speechStart = 0;
      let lastLoud = 0;
      let wasSpeaking = false;
      const threshold = () => Math.max((noiseFloor ?? -60) + SPEECH_ABOVE_FLOOR_DB, MIN_SPEECH_THRESHOLD_DB);
      try {
        while (true) {
          await sleep(POLL_MS);
          if (shouldAbort()) return { uri: null, reason: 'aborted' };
          const now = Date.now();
          // Android reports the peak since the previous read, and -160 when that peak is 0
          // (always the first read), so -160 means "no reading", not silence.
          const level = recorder.getStatus().metering ?? -160;
          if (level <= -150) continue;

          if (isSpeaking()) {
            wasSpeaking = true;
            continue;
          }
          // SIGHT just stopped talking: start a fresh recording so the file has no echo in it.
          if (wasSpeaking && !speechStart) return { uri: null, reason: 'tts_ended' };

          if (noiseFloor === null) {
            if (now - t0 < CALIBRATE_MS) {
              calib.push(level);
              continue;
            }
            noiseFloor = calib.length ? calib.reduce((a, b) => a + b, 0) / calib.length : -60;
          }
          if (level > threshold()) {
            if (!speechStart) speechStart = now;
            lastLoud = now;
          } else if (!speechStart && noiseFloor !== null) {
            // Track slow changes in background noise (walking from a quiet room to a road).
            noiseFloor = noiseFloor * 0.97 + level * 0.03;
          }
          if (speechStart && now - lastLoud > END_SILENCE_MS) {
            if (lastLoud - speechStart < MIN_SPEECH_MS) return { uri: null, reason: 'no_speech' };
            await recorder.stop();
            return { uri: recorder.uri! };
          }
          if (speechStart && now - speechStart > MAX_UTTERANCE_MS) {
            await recorder.stop();
            return { uri: recorder.uri! };
          }
          if (!speechStart && now - t0 > MAX_IDLE_MS) return { uri: null, reason: 'no_speech' };
        }
      } finally {
        if (recorder.getStatus().isRecording) await recorder.stop().catch(() => {});
      }
    },
    [recorder],
  );

  const level = useCallback(() => recorder.getStatus().metering ?? null, [recorder]);

  return { isRecording: state.isRecording, start, stop, listen, level };
}

// A synchronous "the phone is talking" flag, so hands-free listening can drop anything it hears
// while SIGHT itself is speaking. Set on every speak call; cleared by polling the TTS engine
// (after a grace period, because the engine reports "not speaking" for a moment after a call).
let speakingFlag = false;
let lastSpeakCall = 0;
let poller: ReturnType<typeof setInterval> | null = null;

function markSpeaking() {
  speakingFlag = true;
  lastSpeakCall = Date.now();
  if (poller) return;
  poller = setInterval(async () => {
    if (Date.now() - lastSpeakCall < 700) return;
    if (!(await Speech.isSpeakingAsync())) {
      speakingFlag = false;
      if (poller) clearInterval(poller);
      poller = null;
    }
  }, 250);
}

export const isSpeakingNow = () => speakingFlag;

export function speak(text: string, language?: string) {
  Speech.stop();
  markSpeaking();
  Speech.speak(text, { language, rate: 1.0 });
}

// For non-urgent live announcements: never talk over something already being said.
export async function speakIfIdle(text: string) {
  if (speakingFlag || (await Speech.isSpeakingAsync())) return;
  markSpeaking();
  Speech.speak(text, { rate: 1.0 });
}

// Queue after whatever is being said (e.g. the first live description after "Live mode on").
export function speakNext(text: string) {
  markSpeaking();
  Speech.speak(text, { rate: 1.0 });
}

export function stopSpeaking() {
  Speech.stop();
}

/** Resolves once the phone has finished talking, so hands-free listening never hears itself. */
export async function waitUntilQuiet(tailMs = 350) {
  while (speakingFlag || (await Speech.isSpeakingAsync())) await sleep(150);
  await sleep(tailMs);
}

export { sleep };
