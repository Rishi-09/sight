import type { AppAction } from './api';

// Instant, offline handling for short control phrases ("stop live", "repeat"), so the most common
// commands work immediately and even when every AI provider is busy. Anything longer or not
// matched goes to the agent, which can still trigger the same actions through its control_app tool.
const RULES: [AppAction, RegExp][] = [
  ['live_off', /\b(stop|end|close|exit|quit|turn off|switch off|disable|pause|band)\b.*\blive\b|\blive\b.*\b(off|stop|band karo|bandh)\b/],
  ['live_on', /\b(start|open|turn on|switch on|enable|begin|resume|chalu)\b.*\blive\b|\blive\b.*\b(on|start|chalu karo)\b|^live( mode)?$/],
  ['repeat', /^(please )?(repeat( that| it)?|say (that|it) again|again|come again|pardon|what did you say|dobara bolo|phir se bolo)( please)?$/],
  ['stop_speaking', /^(stop|stop talking|stop speaking|quiet|be quiet|silence|shush|chup)( please)?$/],
  ['next_step', /^(next|next step|go on|continue|i'?m there|got it|done|aage)( please)?$/],
  ['open_maps', /^(open |show |go to )?(the )?maps?( screen)?( please)?$/],
  ['open_memory', /^(open |show |go to )?(my )?memory( screen)?( please)?$/],
  ['open_menu', /^(open |show )?(the )?(menu|settings)( please)?$/],
  ['go_home', /^(go )?(back|home|go home|main screen|close( this)?)( please)?$/],
];

export function matchCommand(text: string): AppAction | null {
  const t = text
    .toLowerCase()
    .replace(/[.,!?]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || t.split(' ').length > 7) return null; // long utterances are real requests for the agent
  for (const [action, re] of RULES) if (re.test(t)) return action;
  return null;
}
