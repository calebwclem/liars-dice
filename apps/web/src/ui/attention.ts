/**
 * Getting the player's attention when the turn is theirs.
 *
 * This matters more in a browser than it does on a phone. A phone app is in front of you; a tab
 * is one of fifteen, quite possibly behind a video call with the person you are playing against.
 * R-16 gives you thirty seconds and R-17 plays a minimum raise when they run out, so a turn you
 * did not notice is a turn you lost.
 *
 * Two signals, both cheap and neither requiring a permission prompt: the tab title, and a short
 * tone. Notifications are deliberately not used — a permission dialog on first play costs more
 * goodwill than it buys.
 */

const BASE_TITLE = "Liar's Dice";
const MUTE_KEY = 'liarsdice.muted';

/** The tab title says whose turn it is, so a background tab is readable from the tab strip. */
export function setTitleForTurn(myTurn: boolean): void {
  document.title = myTurn ? `● Your turn — ${BASE_TITLE}` : BASE_TITLE;
}

export function isMuted(): boolean {
  try {
    return window.localStorage.getItem(MUTE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setMuted(muted: boolean): void {
  try {
    window.localStorage.setItem(MUTE_KEY, String(muted));
  } catch {
    /* storage can be refused in private browsing; the toggle still works for this session */
  }
}

let context: AudioContext | null = null;

/**
 * A soft two-note chime.
 *
 * Synthesised rather than loaded, so there is no audio asset to ship and nothing to fetch — which
 * also means it cannot fail on a slow connection at the exact moment it is needed.
 *
 * Browsers refuse audio until the page has been interacted with. By the time it is somebody's
 * turn they have clicked at least one button, so the context is allowed; the `catch` is for the
 * case where it is not, and silence is an acceptable outcome there.
 */
export function playTurnChime(): void {
  if (isMuted()) return;
  try {
    context ??= new AudioContext();
    if (context.state === 'suspended') void context.resume();

    const now = context.currentTime;
    for (const [index, frequency] of [660, 880].entries()) {
      const start = now + index * 0.12;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      // A short bell-ish envelope. A square edge on either end is what makes a synthesised tone
      // sound like a error beep rather than a chime.
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.09, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.28);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.3);
    }
  } catch {
    /* audio is a courtesy, never a requirement */
  }
}
