import { describe, expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TurnRing } from '../src/ui/TurnRing.tsx';

/**
 * The ring's geometry.
 *
 * Rendering it is the only way to catch the failure this kind of component actually has: a NaN
 * reaching `stroke-dashoffset`, which does not throw, does not warn, and simply draws nothing.
 * Effects do not run under `renderToStaticMarkup`, so this sees the first frame — which is the
 * one that matters, since a ring that starts wrong never recovers.
 */
const CIRCUMFERENCE = 2 * Math.PI * 42;

/** The `stroke-dashoffset` of the coloured arc. */
function offset(markup: string): number {
  const matches = [...markup.matchAll(/stroke-dashoffset="([\d.]+)"/g)];
  const last = matches.at(-1)?.[1];
  if (last === undefined) throw new Error(`no stroke-dashoffset in: ${markup}`);
  return Number(last);
}

describe('The turn ring', () => {
  test('a full turn draws a full circle', () => {
    const markup = renderToStaticMarkup(<TurnRing deadline={Date.now() + 30_000} total={30_000} />);
    // Full remaining means no dash offset — the whole arc is drawn.
    expect(offset(markup)).toBeLessThan(CIRCUMFERENCE * 0.02);
    expect(markup).toContain('>30<');
  });

  test('half a turn draws half a circle', () => {
    const markup = renderToStaticMarkup(<TurnRing deadline={Date.now() + 15_000} total={30_000} />);
    expect(offset(markup)).toBeGreaterThan(CIRCUMFERENCE * 0.45);
    expect(offset(markup)).toBeLessThan(CIRCUMFERENCE * 0.55);
  });

  test('an expired turn draws nothing and reads zero, rather than going negative', () => {
    const markup = renderToStaticMarkup(<TurnRing deadline={Date.now() - 5_000} total={30_000} />);
    expect(offset(markup)).toBeCloseTo(CIRCUMFERENCE, 1);
    expect(markup).toContain('>0<');
  });

  test('the last ten seconds turn the ring to the alarm colour', () => {
    const calm = renderToStaticMarkup(<TurnRing deadline={Date.now() + 20_000} total={30_000} />);
    const urgent = renderToStaticMarkup(<TurnRing deadline={Date.now() + 5_000} total={30_000} />);
    expect(calm).toContain('var(--brass)');
    expect(calm).not.toContain('var(--alarm)');
    expect(urgent).toContain('var(--alarm)');
  });

  test('a zero-length turn cannot produce a NaN offset', () => {
    // Defensive: `total` comes off the wire. A division by zero here would silently draw nothing
    // rather than throwing, which is the worst way for this to fail.
    const markup = renderToStaticMarkup(<TurnRing deadline={Date.now()} total={0} />);
    expect(Number.isNaN(offset(markup))).toBe(false);
    expect(markup).not.toContain('NaN');
  });

  test('it announces itself to a screen reader as a timer', () => {
    const markup = renderToStaticMarkup(<TurnRing deadline={Date.now() + 8_000} total={30_000} />);
    expect(markup).toContain('role="timer"');
    expect(markup).toContain('seconds left this turn');
  });
});
