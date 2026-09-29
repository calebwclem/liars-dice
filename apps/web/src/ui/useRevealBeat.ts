/**
 * A reveal, spread out.
 *
 * R-10 happens in one atomic step on the server: every cup comes up, the dice are counted, a die
 * is lost. A person cannot follow that as a single frame — the hands, the count and the verdict
 * all arrive together and you are left working backwards from who lost a die.
 *
 * So the browser paces it, with the same beats and the same timings as the iOS client: cup lift,
 * hands, the counting dice light up, the verdict, then the outcome. Nothing here changes what
 * happened; it only decides when each part of it is drawn. The server holds the table for
 * `REVEAL_MS` (3.5s by default) and the whole sequence fits inside that with room to spare.
 */
import { useEffect, useState } from 'react';

export type RevealBeat = 'cupLift' | 'hands' | 'counting' | 'verdict' | 'outcome';

const ORDER: readonly RevealBeat[] = ['cupLift', 'hands', 'counting', 'verdict', 'outcome'];

/** How long each beat holds before the next one. Lifted from the iOS client so they match. */
const PACING: Readonly<Record<Exclude<RevealBeat, 'outcome'>, number>> = {
  cupLift: 560,
  hands: 420,
  counting: 900,
  verdict: 620,
};

export function atLeast(beat: RevealBeat, wanted: RevealBeat): boolean {
  return ORDER.indexOf(beat) >= ORDER.indexOf(wanted);
}

/**
 * Where the current reveal has got to.
 *
 * `key` identifies *which* reveal is being shown — pass something that changes when a new one
 * starts, and null when none is. A changed key restarts the sequence; an unchanged one leaves a
 * running sequence alone, so an unrelated snapshot arriving mid-reveal does not rewind it.
 */
export function useRevealBeat(key: string | null): RevealBeat {
  const [beat, setBeat] = useState<RevealBeat>('cupLift');

  useEffect(() => {
    if (key === null) {
      setBeat('cupLift');
      return undefined;
    }

    // A staged animation is exactly what "reduce motion" is about. The information is never what
    // gets removed, though — the whole reveal is shown at once instead of being withheld.
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      setBeat('outcome');
      return undefined;
    }

    setBeat('cupLift');
    const timers: number[] = [];
    let elapsed = 0;
    for (const [index, next] of ORDER.slice(1).entries()) {
      const previous = ORDER[index];
      if (previous === undefined || previous === 'outcome') continue;
      elapsed += PACING[previous];
      timers.push(
        window.setTimeout(() => {
          setBeat(next);
        }, elapsed),
      );
    }
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [key]);

  return beat;
}
