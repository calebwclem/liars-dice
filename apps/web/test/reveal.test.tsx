import { describe, expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MatchSnapshot } from '@liars-dice/protocol';
import { Reveal } from '../src/ui/Match.tsx';
import { atLeast, type RevealBeat } from '../src/ui/useRevealBeat.ts';

/**
 * What a reveal shows, beat by beat.
 *
 * The staging is the whole point of pacing it, so the thing worth testing is *what is on screen
 * when* — not the timer arithmetic. Each beat is rendered directly, which also means a future
 * change that accidentally reveals the verdict before the hands fails here rather than in a game.
 */
const reveal: NonNullable<MatchSnapshot['view']['lastReveal']> = {
  roundIndex: 2,
  challengerId: 'them',
  bidderId: 'me',
  bid: { quantity: 3, face: 6 },
  actualCount: 4,
  bidStands: true,
  hands: { me: [6, 1, 2], them: [6, 4, 5] },
  loserId: 'them',
  loserDiceCount: 2,
  eliminatedId: null,
};

const at = (beat: RevealBeat): string =>
  renderToStaticMarkup(<Reveal reveal={reveal} me="me" beat={beat} />);

/** A face-down die renders with the `hidden` class; a face-up one draws pips. */
const faceDown = (markup: string): number => [...markup.matchAll(/die hidden/g)].length;
const lit = (markup: string): number => [...markup.matchAll(/die counting/g)].length;

describe('The reveal, a beat at a time', () => {
  test('beat ordering is a total order', () => {
    expect(atLeast('hands', 'cupLift')).toBe(true);
    expect(atLeast('cupLift', 'hands')).toBe(false);
    expect(atLeast('outcome', 'verdict')).toBe(true);
    expect(atLeast('counting', 'counting')).toBe(true);
  });

  test('cup lift: the challenge is named, every hand is still face down', () => {
    const markup = at('cupLift');
    expect(markup).toContain('challenged');
    expect(faceDown(markup)).toBe(6);
    expect(lit(markup)).toBe(0);
    expect(markup).not.toContain('the bid was');
  });

  test('hands: the cups are up, but nothing is counted yet', () => {
    const markup = at('hands');
    expect(faceDown(markup)).toBe(0);
    expect(lit(markup)).toBe(0);
    expect(markup).not.toContain('the bid was');
  });

  test('counting: the dice that count light up — R-07 includes the wild one', () => {
    const markup = at('counting');
    // Two sixes and one wild one across both hands.
    expect(lit(markup)).toBe(3);
    expect(markup).not.toContain('the bid was');
  });

  test('verdict: the count and the answer, but not yet the cost', () => {
    const markup = at('verdict');
    expect(markup).toContain('4 sixes');
    expect(markup).toContain('the bid was good');
    expect(markup).not.toContain('loses a die');
  });

  test('outcome: who paid for it', () => {
    const markup = at('outcome');
    expect(markup).toContain('the bid was good');
    expect(markup).toContain('loses a die');
    expect(markup).toContain('2 left');
  });

  test('an elimination is named when there is one', () => {
    const markup = renderToStaticMarkup(
      <Reveal reveal={{ ...reveal, eliminatedId: 'them' }} me="me" beat="outcome" />,
    );
    expect(markup).toContain('is out');
  });

  test('a bid on ones lights only real ones, never doubling a wild', () => {
    // R-07's exception, and the one case where the highlight would be wrong if `counts` were
    // applied naively.
    const markup = renderToStaticMarkup(
      <Reveal
        reveal={{ ...reveal, bid: { quantity: 1, face: 1 }, actualCount: 1 }}
        me="me"
        beat="counting"
      />,
    );
    expect(lit(markup)).toBe(1);
  });
});
