// Spoken "thinking" phrases, so a slow AI answer sounds like a person checking, not a frozen app.
// Each one is spoken only if the phone is quiet; the real answer cuts it off as soon as it arrives.

const VISUAL = /\b(see|look|front|ahead|around|door|sign|read|camera|describe|colou?r|where is|what is (this|that)|what's (this|that)|stairs|obstacle|entrance|room)\b/i;

const OPEN_VISUAL = ['Let me take a look.', 'Looking now.', 'Let me see.', 'Checking the camera.'];
const OPEN_GENERAL = ['One moment.', 'Let me check.', 'Sure, one second.', 'On it.'];
const STILL = ['Still working on it.', 'Just a little longer.', 'Bear with me a second.'];
const ALMOST = ['Almost there.', 'Nearly done.'];
const RETRY = ["Give me a second, I'm thinking about that.", 'Hang on, let me try that again.', 'Just a moment more.'];
const LIVE_CATCHING_UP = ['Live view is catching up, one moment.', 'Still watching, give me a second.'];

let turn = 0;
const pick = (options: string[]) => options[turn++ % options.length];

export const retryFiller = () => pick(RETRY);
export const liveCatchingUp = () => pick(LIVE_CATCHING_UP);

/** Schedules fillers for a request; call the returned function when the answer (or error) arrives. */
export function startFillers(request: string, say: (text: string) => void): () => void {
  const opener = VISUAL.test(request) ? OPEN_VISUAL : OPEN_GENERAL;
  const timers = [
    setTimeout(() => say(pick(opener)), 1200),
    setTimeout(() => say(pick(STILL)), 6000),
    setTimeout(() => say(pick(ALMOST)), 12000),
  ];
  return () => timers.forEach(clearTimeout);
}
