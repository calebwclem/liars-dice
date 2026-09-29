import { describe, expect, test } from 'vitest';
import type { Face } from '@liars-dice/protocol';
import { counts, shortName, spoken } from '../src/ui/Dice.tsx';

const FACES: readonly Face[] = [1, 2, 3, 4, 5, 6];

describe('Saying a bid out loud', () => {
  test('every face has a correct singular', () => {
    // "1 sixe" reached a screenshot. The old rule dropped the plural's last letter, which is
    // right for five faces out of six — so a test that checked any of those five passed.
    expect(FACES.map((face) => spoken(1, face))).toEqual([
      '1 one',
      '1 two',
      '1 three',
      '1 four',
      '1 five',
      '1 six',
    ]);
  });

  test('every face has a correct plural', () => {
    expect(FACES.map((face) => spoken(3, face))).toEqual([
      '3 ones',
      '3 twos',
      '3 threes',
      '3 fours',
      '3 fives',
      '3 sixes',
    ]);
  });

  test('zero is plural, as English insists', () => {
    expect(spoken(0, 6)).toBe('0 sixes');
  });
});

describe('R-07 in the highlight', () => {
  test('a one counts toward any other face', () => {
    expect(counts(1, 6)).toBe(true);
    expect(counts(6, 6)).toBe(true);
    expect(counts(5, 6)).toBe(false);
  });

  test('a bid on ones counts only real ones', () => {
    expect(counts(1, 1)).toBe(true);
    expect(counts(6, 1)).toBe(false);
  });
});

describe('Naming people', () => {
  test('you are "You", bots are named, guests are shortened', () => {
    expect(shortName('me', 'me')).toBe('You');
    expect(shortName('bot_a1b2c3', 'me')).toBe('Bot b2c3');
    expect(shortName('g_4e8861cf-dead', 'me')).toBe('Player 4e88');
  });
});
