import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { isMuted, setMuted, setTitleForTurn } from '../src/ui/attention.ts';

/**
 * The turn signals.
 *
 * These run without a DOM, so `document` and `localStorage` are stubbed. That is not a
 * compromise: what is worth checking here is the *policy* — that the title says whose turn it is,
 * that the mute preference survives, and that a refused storage never takes the page down with
 * it. None of that needs a browser.
 */
describe('Getting the player back to the tab', () => {
  let store: Record<string, string>;

  beforeEach(() => {
    store = {};
    vi.stubGlobal('document', { title: '' });
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store[key] ?? null,
        setItem: (key: string, value: string) => {
          store[key] = value;
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('the tab title says whose turn it is', () => {
    setTitleForTurn(true);
    expect(document.title).toContain('Your turn');
    setTitleForTurn(false);
    expect(document.title).toBe("Liar's Dice");
    expect(document.title).not.toContain('Your turn');
  });

  test('muting persists, because nobody wants to mute once per match', () => {
    expect(isMuted()).toBe(false);
    setMuted(true);
    expect(isMuted()).toBe(true);
    setMuted(false);
    expect(isMuted()).toBe(false);
  });

  test('storage being refused leaves the page working, just unmuted', () => {
    // Private browsing can throw on any access. A thrown exception here would happen during a
    // render and take the match down over a sound preference.
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('refused');
        },
        setItem: () => {
          throw new Error('refused');
        },
      },
    });
    expect(() => setMuted(true)).not.toThrow();
    expect(isMuted()).toBe(false);
  });
});
