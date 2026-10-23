import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as Haptics from 'expo-haptics';
import { File } from 'expo-file-system';

import { AgentResponse, API_URL, AppAction, checkHealth, Coords, getMission, Mission, nextStep, sendLiveFrame, sendText, stopLive, transcribe } from './src/api';
import { matchCommand } from './src/commands';
import { MapsScreen } from './src/MapsScreen';
import { MemoryScreen } from './src/MemoryScreen';
import { MenuScreen } from './src/MenuScreen';
import { colors } from './src/theme';
import { liveCatchingUp, retryFiller, startFillers } from './src/fillers';
import { loadSettings, saveSettings, validWakeName } from './src/settings';
import { distanceM, useLocation } from './src/useLocation';
import { isSpeakingNow, sleep, speak, speakIfIdle, speakNext, stopSpeaking, useVoice } from './src/useVoice';
import { stripWakeWord, whisperPrompt } from './src/wakeWord';

const ARRIVAL_RADIUS_M = 15;
const LIVE_INTERVAL_MS = 4500; // ~13 frames/min; the server's backoff_s slows this further if rate limited
const LIVE_FRAME_WIDTH = 640; // smaller than push-to-talk frames: faster upload and inference
const FOLLOW_UP_MS = 8000; // after SIGHT answers, a reply within this window needs no wake word
const SAFETY_NOTE = 'Remember, keep using your cane or guide dog as usual. I can only give guidance, not guarantee a safe path.';
const welcome = (name: string) =>
  `${name} is ready and listening. Start with my name, for example: ${name}, what's in front of me? ` +
  `Or: ${name}, start live. ` +
  'Repeat is the top left corner, Talk is bottom left, Live is bottom right.';

// Spoken whenever the user lands on a screen, so the app describes itself without a screen reader.
const screenIntro = (screen: Screen, name: string) =>
  ({
    home: 'Camera screen.',
    menu: `Menu. Options: Maps, Memory, type a request, my name, hands-free listening, wake word, and review before sending. Say ${name}, go back, to return.`,
    maps: `Maps. You can also add places by voice: say ${name}, create a place called, and the name. Say ${name}, go back, to return to the camera.`,
    memory: 'Memory.',
  })[screen];

// "change your name to Buddy", "call yourself Max", "your name is now Nova"
const RENAME = /^(?:please )?(?:change|set) (?:your|the) (?:name|wake word) to (.+)$|^(?:call yourself|rename yourself(?: to)?|your (?:new )?name is(?: now)?) (.+)$/i;

// A voice turn runs in two phases: 'transcribing' (speech-to-text) then 'thinking' (the agent).
type Phase = 'idle' | 'transcribing' | 'thinking';
type Screen = 'home' | 'menu' | 'maps' | 'memory';

function deleteQuietly(uri: string) {
  try {
    new File(uri).delete();
  } catch {}
}

// Only heard after an automatic retry has also failed, so they stay calm and brief.
function describeError(e: any): { spoken: string; detail: string } {
  const detail = String(e?.message ?? e);
  if (e?.name === 'AbortError') return { spoken: 'That took longer than expected. Please ask me again.', detail };
  if (detail.startsWith('Server error')) return { spoken: 'Sorry, something went wrong on my side. Please ask me again.', detail };
  return { spoken: "I can't reach my server right now. Please check the connection.", detail };
}

export default function App() {
  const [camPerm, requestCamPerm] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const voice = useVoice();
  const { coords, accuracy, heading } = useLocation();

  const [initial] = useState(loadSettings);
  const [screen, setScreen] = useState<Screen>('home');
  const [phase, setPhase] = useState<Phase>('idle');
  const busy = phase !== 'idle';
  // Off by default: a screen-reader user shouldn't have to confirm every request.
  const [reviewFirst, setReviewFirst] = useState(initial.reviewFirst);
  const [wakeName, setWakeName] = useState(initial.wakeName);
  const [pendingText, setPendingText] = useState(''); // transcript waiting for review in the menu
  const [transcript, setTranscript] = useState('');
  const [reply, setReply] = useState(`Say: ${initial.wakeName}, what's in front of me?`);
  const lastReplyRef = useRef(''); // what "repeat" replays; never overwritten by the repeat confirmation itself
  const [mission, setMission] = useState<Mission | null>(null);
  const [serverStatus, setServerStatus] = useState(`Checking ${API_URL}…`);
  const advancing = useRef(false);

  // Hands-free listening: always on unless switched off. Speech must start with the wake word,
  // except in the short follow-up window after SIGHT answers.
  const [handsFree, setHandsFree] = useState(initial.handsFree);
  const [wakeWord, setWakeWord] = useState(initial.wakeWord);
  const [heard, setHeard] = useState(''); // last thing hands-free picked up, for the agent panel
  const handsFreeRef = useRef(initial.handsFree);
  const wakeWordRef = useRef(initial.wakeWord);
  const wakeNameRef = useRef(initial.wakeName);
  wakeNameRef.current = wakeName;
  const hfPausedRef = useRef(false); // e.g. while the Maps screen dictates
  const followUpUntilRef = useRef(0);
  const openFollowUpRef = useRef(false); // open the follow-up window once SIGHT stops talking

  // Live mode runs a loop across many renders, so it reads refs rather than state.
  const [live, setLive] = useState(false);
  const [liveInfo, setLiveInfo] = useState('');
  const liveRef = useRef(false);
  const livePausedRef = useRef(false); // true while thinking, recording by hand, or off the camera screen
  const captureLock = useRef<Promise<unknown>>(Promise.resolve());

  // Background loops are started once, so they read current values through these refs.
  const phaseRef = useRef<Phase>('idle');
  const screenRef = useRef<Screen>('home');
  const coordsRef = useRef<Coords>(null);
  const headingRef = useRef<number | null>(null);
  const missionRef = useRef<Mission | null>(null);
  const reviewRef = useRef(false);
  phaseRef.current = phase;
  screenRef.current = screen;
  coordsRef.current = coords;
  headingRef.current = heading;
  missionRef.current = mission;
  reviewRef.current = reviewFirst;
  const onUtteranceRef = useRef<(uri: string) => Promise<void>>(async () => {});

  useEffect(() => {
    if (camPerm && !camPerm.granted) requestCamPerm();
  }, [camPerm]);

  useEffect(() => {
    checkHealth()
      .then(() => setServerStatus(`Server OK (${API_URL})`))
      .catch((e) => {
        console.error('[SIGHT] health check failed', API_URL, e);
        setServerStatus(`Server unreachable at ${API_URL}: ${e?.message ?? e}`);
      });
    getMission().then((r) => setMission(r.mission)).catch(() => {});
    speak(welcome(initial.wakeName));
    handsFreeLoop();
    return () => {
      liveRef.current = false;
      handsFreeRef.current = false;
    };
  }, []);

  // Announce each screen on arrival (the app talks instead of relying on the system screen reader).
  const firstScreen = useRef(true);
  useEffect(() => {
    livePausedRef.current = screen !== 'home';
    if (firstScreen.current) {
      firstScreen.current = false;
      return;
    }
    speak(screenIntro(screen, wakeNameRef.current));
  }, [screen]);

  // Settings survive restarts (they live in a small JSON file on the phone).
  useEffect(() => {
    saveSettings({ wakeName, handsFree, wakeWord, reviewFirst });
  }, [wakeName, handsFree, wakeWord, reviewFirst]);

  // GPS auto-advance: when we reach the next step's waypoint, move on and speak it.
  useEffect(() => {
    if (!mission?.step || !coords || advancing.current) return;
    const next = mission.steps[mission.current_step + 1];
    if (!next || next.lat == null || next.lng == null) return;
    if (distanceM(coords, { lat: next.lat, lng: next.lng }) > ARRIVAL_RADIUS_M) return;
    advancing.current = true;
    nextStep(coords)
      .then((r) => {
        setMission(r.mission);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        say(r.spoken);
      })
      .catch(() => {})
      .finally(() => (advancing.current = false));
  }, [coords, mission]);

  function say(text: string) {
    setReply(text);
    lastReplyRef.current = text;
    speak(text);
  }

  // ---------- hands-free listening ----------

  async function handsFreeLoop() {
    while (true) {
      if (!handsFreeRef.current) {
        await sleep(300);
        continue;
      }
      if (hfPausedRef.current || phaseRef.current !== 'idle') {
        await sleep(250);
        continue;
      }
      // Once SIGHT has finished answering, open the no-wake-word follow-up window.
      if (openFollowUpRef.current && !isSpeakingNow()) {
        openFollowUpRef.current = false;
        followUpUntilRef.current = Date.now() + FOLLOW_UP_MS;
      }
      try {
        // The mic is ignored while SIGHT talks (see useVoice.listen), so it never hears itself.
        const res = await voice.listen({
          shouldAbort: () => !handsFreeRef.current || hfPausedRef.current || phaseRef.current !== 'idle',
          isSpeaking: isSpeakingNow,
        });
        if (res.uri !== null) {
          await onUtteranceRef.current(res.uri);
        } else if (res.reason === 'tts_ended') {
          await sleep(200); // let the speaker's echo die away before recording again
        }
      } catch (e) {
        console.error('[SIGHT] hands-free listen failed', e);
        await sleep(1000);
      }
    }
  }

  function setHandsFreeMode(on: boolean, announce = true) {
    handsFreeRef.current = on;
    setHandsFree(on);
    if (announce) speak(on ? `Hands-free on. Start with my name, ${wakeNameRef.current}.` : 'Hands-free off. Tap Talk, bottom left, to speak.');
  }

  function setWakeWordMode(on: boolean) {
    wakeWordRef.current = on;
    setWakeWord(on);
    speak(on ? `Wake word on. Start with my name, ${wakeNameRef.current}.` : 'Wake word off. I will respond to anything I hear.');
  }

  function renameAssistant(raw: string) {
    const name = validWakeName(raw);
    if (!name) {
      say("That name won't work well. Pick a name of one or two words, at least three letters, that isn't a common command.");
      return;
    }
    wakeNameRef.current = name;
    setWakeName(name);
    say(`Okay. Call me ${name} from now on. For example: ${name}, start live.`);
  }

  // Handles one hands-free utterance. Re-assigned every render so it sees current state.
  onUtteranceRef.current = async (uri: string) => {
    let text = '';
    try {
      text = (await transcribe(uri, whisperPrompt(wakeNameRef.current))).transcript.trim();
    } catch (e) {
      console.error('[SIGHT] transcribe failed', e);
      return;
    }
    if (!text) return;
    const inFollowUp = Date.now() < followUpUntilRef.current;
    const rest = stripWakeWord(text, wakeNameRef.current);
    if (wakeWordRef.current && !inFollowUp) {
      if (rest === null) {
        setHeard(`(ignored, no wake word) ${text}`);
        return; // background speech: stay silent
      }
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      if (!rest) {
        speak('Yes?');
        openFollowUpRef.current = true;
        return;
      }
      text = rest;
    } else if (rest) {
      text = rest; // "Sight, ..." during a follow-up still works
    }
    setHeard('');
    followUpUntilRef.current = 0;
    await handleRequest(text);
    openFollowUpRef.current = true;
  };

  // Map dictation borrows the same recorder: pause hands-free, listen once, transcribe.
  async function dictateOnce(): Promise<string> {
    hfPausedRef.current = true;
    try {
      await sleep(300); // let an in-progress hands-free listen abort and release the recorder
      const res = await voice.listen({ shouldAbort: () => false });
      return res.uri ? (await transcribe(res.uri)).transcript.trim() : '';
    } finally {
      hfPausedRef.current = false;
    }
  }

  // ---------- camera + live mode ----------

  // Serialized: the camera can't take two pictures at once, and live mode and requests both capture.
  function captureFrame(width = 1024): Promise<string | null> {
    const run = captureLock.current.then(async () => {
      try {
        const pic = await camera.current?.takePictureAsync({ quality: 0.5, shutterSound: false });
        if (!pic) return null;
        const small = await manipulateAsync(pic.uri, [{ resize: { width } }], { compress: 0.6, format: SaveFormat.JPEG });
        deleteQuietly(pic.uri);
        return small.uri;
      } catch {
        return null;
      }
    });
    captureLock.current = run;
    return run;
  }

  async function liveLoop() {
    let busyStreak = 0; // consecutive frames skipped because the AI was busy
    while (liveRef.current) {
      const started = Date.now();
      let backoffMs = 0;
      if (!livePausedRef.current) {
        const uri = await captureFrame(LIVE_FRAME_WIDTH);
        if (uri && liveRef.current && !livePausedRef.current) {
          try {
            const res = await sendLiveFrame(uri);
            if (!liveRef.current) break;
            if (res.backoff_s) backoffMs = res.backoff_s * 1000;
            // A long silence in live mode sounds broken, so say so once (not every frame).
            busyStreak = res.reason === 'busy' || res.error ? busyStreak + 1 : 0;
            if (busyStreak === 3) speakIfIdle(liveCatchingUp());
            setLiveInfo(
              res.error
                ? `Live error: ${res.error}`
                : res.reason === 'busy'
                  ? `Vision busy, retrying in ${res.backoff_s}s`
                  : `${res.summary ?? ''} (${res.latency_s ?? '?'}s)`,
            );
            if (res.speak && !livePausedRef.current) {
              lastReplyRef.current = res.speak;
              setReply(res.speak);
              if (res.hazard) {
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
                speak(res.speak);
              } else if (res.reason === 'first') {
                speakNext(res.speak); // right after "Live mode on", don't skip it
              } else {
                speakIfIdle(res.speak);
              }
            }
          } catch (e: any) {
            setLiveInfo(`Live error: ${e?.message ?? e}`);
          }
        }
        if (uri) deleteQuietly(uri);
      }
      const wait = Math.max(LIVE_INTERVAL_MS - (Date.now() - started), backoffMs);
      if (wait > 0) await sleep(wait);
    }
  }

  function setLiveMode(on: boolean, announce = true) {
    if (on === liveRef.current) {
      if (announce) speak(on ? 'Live mode is already on.' : 'Live mode is already off.');
      return;
    }
    liveRef.current = on;
    setLive(on);
    Haptics.notificationAsync(on ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning);
    if (on) {
      if (screenRef.current !== 'home') setScreen('home'); // live needs the camera
      if (announce) speak('Live mode on. Looking now.');
      liveLoop(); // captures the first frame immediately; its description is queued after the announcement
    } else {
      setLiveInfo('');
      stopLive().catch(() => {});
      if (announce) speak('Live mode off.');
    }
  }

  // ---------- actions the user can trigger by voice (locally matched, or requested by the agent) ----------

  async function runAction(action: AppAction, announce: boolean) {
    if (action.startsWith('set_wake_word:')) return renameAssistant(action.slice('set_wake_word:'.length));
    switch (action) {
      case 'live_on':
        return setLiveMode(true, announce);
      case 'live_off':
        return setLiveMode(false, announce);
      case 'repeat':
        return speak(lastReplyRef.current || "There's nothing to repeat yet.");
      case 'stop_speaking':
        return stopSpeaking();
      case 'next_step':
        return onNext();
      case 'open_maps':
        return setScreen('maps');
      case 'open_memory':
        return setScreen('memory');
      case 'open_menu':
        return setScreen('menu');
      case 'go_home':
        return setScreen('home');
      case 'review_on':
      case 'review_off':
        setReviewFirst(action === 'review_on');
        return announce && speak(action === 'review_on' ? "I'll let you review before sending." : "I'll send right away.");
    }
  }

  function handleResponse(res: AgentResponse) {
    const actions = res.actions ?? [];
    const startedMission = !missionRef.current && !!res.mission;
    setMission(res.mission ?? null);
    if (res.confidence === 'low') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);

    const navigates = actions.some((a) => ['open_maps', 'open_memory', 'open_menu', 'go_home'].includes(a));
    if (actions.some((a) => a.startsWith('set_wake_word:'))) {
      setReply(res.reply); // renameAssistant() speaks the confirmation with the new name
    } else if (actions.includes('repeat')) {
      runAction('repeat', false); // replay the previous answer, not the agent's "Repeating."
    } else if (actions.includes('next_step')) {
      setReply(res.reply); // the step instruction itself is the useful reply
    } else if (!navigates) {
      say(startedMission ? `${res.reply} ${SAFETY_NOTE}` : res.reply);
    } else {
      setReply(res.reply); // the new screen announces itself
    }
    for (const a of actions) if (a !== 'repeat') runAction(a, false);
  }

  function showError(e: any) {
    console.error('[SIGHT] request failed', API_URL, e);
    const { spoken, detail } = describeError(e);
    setReply(`${spoken}\n[${detail}]`);
    speak(spoken);
  }

  // Phase 2: send text (typed, or a transcript) to the agent along with a fresh camera frame.
  // While waiting it speaks short fillers, and a busy or failed request is retried once behind a
  // filler, so the user hears a natural pause instead of silence or an error.
  async function ask(text: string) {
    setTranscript(text);
    setPhase('thinking');
    livePausedRef.current = true;
    const stopFillers = startFillers(text, speakIfIdle);
    try {
      const img = screenRef.current === 'home' ? await captureFrame() : null;
      const send = () => sendText(text, img, coordsRef.current, headingRef.current);
      let res: AgentResponse;
      try {
        res = await send();
      } catch (e) {
        console.warn('[SIGHT] request failed, retrying once', e);
        speakIfIdle(retryFiller());
        await sleep(1500);
        res = await send();
      }
      if (res.busy_retry_after) {
        speakIfIdle(retryFiller());
        await sleep(res.busy_retry_after * 1000);
        res = await send();
      }
      stopFillers();
      handleResponse(res);
    } catch (e) {
      stopFillers();
      showError(e);
    } finally {
      stopFillers();
      setPhase('idle');
      livePausedRef.current = screenRef.current !== 'home';
    }
  }

  // Shared by hands-free and tap-to-talk once there's text: instant command, review, or the agent.
  async function handleRequest(text: string) {
    const rename = text.replace(/[.!?]+$/, '').match(RENAME);
    if (rename) {
      setTranscript(text);
      renameAssistant(rename[1] ?? rename[2]);
      return;
    }
    const command = matchCommand(text);
    if (command) {
      setTranscript(text);
      await runAction(command, true);
      return;
    }
    if (reviewRef.current) {
      setPendingText(text);
      setScreen('menu');
      speak(`I heard: ${text}. Edit it in the text box, then press send.`);
      return;
    }
    await ask(text);
  }

  // Tap-to-talk. With hands-free on, a tap just means "I'm about to speak, no wake word needed".
  async function onTalk() {
    if (busy) return;
    if (handsFreeRef.current) {
      followUpUntilRef.current = Date.now() + FOLLOW_UP_MS;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      speak('Yes?');
      return;
    }
    if (!voice.isRecording) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      livePausedRef.current = true;
      await voice.start();
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const audioUri = await voice.stop();
    if (audioUri) {
      setPhase('transcribing');
      setTranscript('…');
      try {
        const res = await transcribe(audioUri, whisperPrompt(wakeNameRef.current));
        setPhase('idle');
        if (res.transcript.trim()) await handleRequest(stripWakeWord(res.transcript, wakeNameRef.current) || res.transcript.trim());
        else say(res.reply ?? "I didn't hear anything. Please try again.");
      } catch (e) {
        setPhase('idle');
        setTranscript('');
        showError(e);
      }
    }
    livePausedRef.current = false;
  }

  async function onNext() {
    try {
      const r = await nextStep(coordsRef.current);
      setMission(r.mission);
      say(r.spoken);
    } catch {
      speak("I couldn't reach the server.");
    }
  }

  // ---------- other screens ----------

  if (screen === 'menu') {
    return (
      <MenuScreen
        serverStatus={serverStatus}
        reviewFirst={reviewFirst}
        handsFree={handsFree}
        wakeWord={wakeWord}
        wakeName={wakeName}
        initialText={pendingText}
        onToggleReview={() => setReviewFirst((v) => !v)}
        onToggleHandsFree={() => setHandsFreeMode(!handsFreeRef.current)}
        onToggleWakeWord={() => setWakeWordMode(!wakeWordRef.current)}
        onRename={renameAssistant}
        onOpenMaps={() => setScreen('maps')}
        onOpenMemory={() => setScreen('memory')}
        onSendTyped={(t) => {
          setPendingText('');
          setScreen('home');
          ask(t);
        }}
        onClose={() => {
          setPendingText('');
          setScreen('home');
        }}
      />
    );
  }
  if (screen === 'maps') {
    return <MapsScreen coords={coords} accuracy={accuracy} heading={heading} dictate={dictateOnce} onClose={() => setScreen('home')} />;
  }
  if (screen === 'memory') return <MemoryScreen onClose={() => setScreen('home')} />;

  // ---------- home: four corners around the camera ----------

  const statusLine =
    phase === 'transcribing'
      ? 'Transcribing…'
      : phase === 'thinking'
        ? 'Thinking…'
        : voice.isRecording && !handsFree
          ? 'Listening…'
          : handsFree
            ? wakeWord
              ? `Listening for "${wakeName}"`
              : 'Listening'
            : 'Tap Talk to speak';
  const serverOk = serverStatus.startsWith('Server OK');

  return (
    <View style={styles.root}>
      <StatusBar style="light" />

      <View style={styles.topRow}>
        <Pressable
          style={styles.repeat}
          onPress={() => runAction('repeat', true)}
          accessibilityRole="button"
          accessibilityLabel="Repeat"
          accessibilityHint="Says the last answer again"
        >
          <Text style={styles.repeatIcon}>↻</Text>
          <Text style={styles.cornerLabel}>Repeat</Text>
        </Pressable>

        <Pressable
          style={styles.agent}
          onPress={() => setScreen('menu')}
          accessibilityRole="button"
          accessibilityLabel={`Agent. ${statusLine}. ${transcript ? `You said: ${transcript}. ` : ''}${reply}`}
          accessibilityHint="Double tap for the menu: maps, memory, typing and settings"
        >
          <View style={styles.agentHeader}>
            <Text style={[styles.agentStatus, (busy || handsFree) && { color: colors.accent }]} numberOfLines={1}>
              ● {statusLine}
            </Text>
            <Text style={styles.menuHint}>Menu ›</Text>
          </View>
          {!!transcript && (
            <Text style={styles.agentYou} numberOfLines={1}>
              You: {transcript}
            </Text>
          )}
          <Text style={styles.agentReply} numberOfLines={3}>
            {reply}
          </Text>
          {!!heard && (
            <Text style={styles.agentHeard} numberOfLines={1}>
              {heard}
            </Text>
          )}
          {!serverOk && (
            <Text style={styles.agentWarn} numberOfLines={2}>
              {serverStatus}
            </Text>
          )}
        </Pressable>
      </View>

      <View style={styles.cameraBox} accessible accessibilityLabel="Camera view. Point the phone at what you want to ask about.">
        {camPerm?.granted ? (
          <CameraView ref={camera} style={StyleSheet.absoluteFill} facing="back" animateShutter={false} />
        ) : (
          <Text style={styles.body}>Camera permission needed.</Text>
        )}
        {live && !!liveInfo && (
          <View style={styles.liveOverlay} pointerEvents="none">
            <Text style={styles.overlayText} numberOfLines={2}>
              👁 {liveInfo}
            </Text>
          </View>
        )}
        {mission?.step && (
          <Pressable
            style={styles.missionOverlay}
            onPress={onNext}
            accessibilityRole="button"
            accessibilityLabel={`Mission to ${mission.destination}. Step ${mission.current_step + 1} of ${mission.total_steps}. ${mission.step.instruction}`}
            accessibilityHint="Double tap for the next step"
          >
            <Text style={styles.missionTitle}>
              {mission.destination} · Step {mission.current_step + 1}/{mission.total_steps} · tap for next
            </Text>
            <Text style={styles.overlayText} numberOfLines={2}>
              {mission.step.instruction}
            </Text>
            {accuracy != null && accuracy > 20 && <Text style={styles.small}>GPS weak (±{Math.round(accuracy)} m)</Text>}
          </Pressable>
        )}
      </View>

      <View style={styles.bottomRow}>
        <Pressable
          style={[styles.talk, voice.isRecording && !handsFree && styles.talkRecording]}
          onPress={onTalk}
          onLongPress={() => setHandsFreeMode(!handsFreeRef.current)}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={handsFree ? 'Talk. Hands-free is on.' : voice.isRecording ? 'Listening. Tap to stop.' : busy ? statusLine : 'Talk'}
          accessibilityHint={
            handsFree
              ? 'Double tap to speak without the wake word. Long press to turn hands-free off.'
              : 'Double tap, then ask anything. Long press to turn hands-free on.'
          }
          accessibilityState={{ busy, disabled: busy }}
        >
          {busy ? (
            <>
              <ActivityIndicator size="large" color={colors.bg} />
              <Text style={styles.phaseText}>{phase === 'transcribing' ? 'Transcribing…' : 'Thinking…'}</Text>
            </>
          ) : (
            <>
              <Text style={styles.cornerIcon}>{voice.isRecording && !handsFree ? '■' : '🎤'}</Text>
              <Text style={styles.talkText}>{voice.isRecording && !handsFree ? 'Stop' : 'Talk'}</Text>
              {handsFree && <Text style={styles.hfText}>hands-free on</Text>}
            </>
          )}
        </Pressable>

        <Pressable
          style={[styles.live, live && styles.liveOn]}
          onPress={() => setLiveMode(!liveRef.current)}
          accessibilityRole="switch"
          accessibilityState={{ checked: live }}
          accessibilityLabel={live ? 'Live mode, on' : 'Live mode, off'}
          accessibilityHint={live ? 'Double tap to stop live descriptions' : 'Double tap to hear hazards and changes continuously'}
        >
          <Text style={styles.cornerIcon}>{live ? '◉' : '👁'}</Text>
          <Text style={[styles.liveText, live && { color: '#fff' }]}>{live ? 'Live ON' : 'Live'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, paddingTop: 40, paddingHorizontal: 10, paddingBottom: 16 },
  body: { color: colors.fg, fontSize: 18 },
  small: { color: colors.muted, fontSize: 14 },

  topRow: { flexDirection: 'row', gap: 10, height: 150, marginBottom: 10 },
  repeat: { width: 120, borderRadius: 20, borderWidth: 3, borderColor: colors.fg, justifyContent: 'center', alignItems: 'center' },
  repeatIcon: { color: colors.fg, fontSize: 44, fontWeight: '700' },
  cornerLabel: { color: colors.fg, fontSize: 20, fontWeight: '700' },
  agent: { flex: 1, borderRadius: 20, borderWidth: 2, borderColor: colors.muted, padding: 12, backgroundColor: '#0d0d0d' },
  agentHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4, gap: 6 },
  agentStatus: { color: colors.muted, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  menuHint: { color: colors.accent, fontSize: 15, fontWeight: '700' },
  agentYou: { color: colors.muted, fontSize: 14, marginBottom: 2 },
  agentReply: { color: colors.fg, fontSize: 17, lineHeight: 22 },
  agentHeard: { color: '#666', fontSize: 12, marginTop: 2 },
  agentWarn: { color: colors.recording, fontSize: 13, marginTop: 2 },

  cameraBox: { flex: 1, borderRadius: 20, overflow: 'hidden', backgroundColor: '#111', justifyContent: 'center', alignItems: 'center', marginBottom: 10 },
  liveOverlay: { position: 'absolute', top: 0, left: 0, right: 0, padding: 10, backgroundColor: 'rgba(0,0,0,0.6)' },
  missionOverlay: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: 12, backgroundColor: 'rgba(0,0,0,0.75)', borderTopWidth: 2, borderTopColor: colors.accent },
  missionTitle: { color: colors.accent, fontSize: 15, fontWeight: '700', marginBottom: 2 },
  overlayText: { color: colors.fg, fontSize: 16 },

  bottomRow: { flexDirection: 'row', gap: 10, height: 180 },
  talk: { flex: 1, borderRadius: 24, backgroundColor: colors.accent, justifyContent: 'center', alignItems: 'center' },
  talkRecording: { backgroundColor: colors.recording },
  talkText: { color: colors.bg, fontSize: 34, fontWeight: '800' },
  hfText: { color: colors.bg, fontSize: 14, fontWeight: '700' },
  phaseText: { color: colors.bg, fontSize: 18, fontWeight: '700', marginTop: 6 },
  live: { flex: 1, borderRadius: 24, borderWidth: 3, borderColor: colors.fg, justifyContent: 'center', alignItems: 'center' },
  liveOn: { backgroundColor: colors.recording, borderColor: colors.recording },
  liveText: { color: colors.fg, fontSize: 34, fontWeight: '800' },
  cornerIcon: { fontSize: 36, marginBottom: 4 },
});
