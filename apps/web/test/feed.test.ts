import { describe, expect, test } from 'vitest';
import type { ProtocolEvent } from '@liars-dice/protocol';
import { summarise } from '../src/ui/Match.tsx';
import { possessive, subject } from '../src/ui/Dice.tsx';

/**
 * The feed, conjugated.
 *
 * "You opens" is what happens when third-person copy meets a second-person name, and it reached
 * a screenshot. So this sweeps *every* event variant from both points of view rather than
 * spot-checking two of them — the earlier tests did the latter and missed this for weeks.
 */
const ME = 'me';

/** Every event variant, with the subject set to whoever is given. */
function everyEvent(who: string): ProtocolEvent[] {
  return [
    { type: 'matchStarted', playerIds: [who, 'dana'], startingDice: 5 },
    { type: 'roundStarted', index: 0, starterId: who, diceCounts: { [who]: 5 } },
    { type: 'bidMade', playerId: who, bid: { quantity: 2, face: 6 } },
    { type: 'dudoCalled', playerId: who, bidderId: 'dana', bid: { quantity: 2, face: 6 } },
    {
      type: 'diceRevealed',
      reveal: {
        roundIndex: 0,
        challengerId: who,
        bidderId: 'dana',
        bid: { quantity: 2, face: 6 },
        actualCount: 2,
        bidStands: true,
        hands: {},
        loserId: who,
        loserDiceCount: 4,
        eliminatedId: null,
      },
    },
    { type: 'dieLost', playerId: who, diceCount: 4 },
    { type: 'playerEliminated', playerId: who },
    { type: 'matchEnded', winnerId: who },
    { type: 'playerTimedOut', playerId: who, consecutive: 1, autoBid: null },
    { type: 'playerDisconnected', playerId: who, graceMs: 45_000 },
    { type: 'playerReconnected', playerId: who },
    { type: 'botTookOver', playerId: who, reason: 'afk' },
    { type: 'controlReturned', playerId: who },
    { type: 'matchAbandoned', reason: 'allHumansDisconnected' },
  ];
}

/** Third-person verb forms that must never follow "You". */
const THIRD_PERSON = [
  /\bYou opens\b/,
  /\bYou bids\b/,
  /\bYou challenges\b/,
  /\bYou loses\b/,
  /\bYou wins\b/,
  /\bYou is\b/,
  /\bYou has\b/,
  /\bYou are out\b.*\bis\b/,
  /\bYou's\b/,
  /\bYou’s\b/,
];

describe('The event feed reads as English', () => {
  test('nothing said about you is in the third person', () => {
    for (const event of everyEvent(ME)) {
      const line = summarise(event, ME);
      for (const wrong of THIRD_PERSON) {
        expect(line, `"${line}" (${event.type})`).not.toMatch(wrong);
      }
    }
  });

  test('the specific line from the screenshot', () => {
    const opening: ProtocolEvent = {
      type: 'roundStarted',
      index: 0,
      starterId: ME,
      diceCounts: { me: 5 },
    };
    expect(summarise(opening, ME)).toBe('Round 1: You open');
    expect(summarise(opening, 'somebody-else')).toBe('Round 1: Player me opens');
  });

  test('every variant says something, from either point of view', () => {
    for (const who of [ME, 'dana']) {
      for (const event of everyEvent(who)) {
        const line = summarise(event, ME);
        expect(line.length, `${event.type} said nothing`).toBeGreaterThan(0);
        expect(line, `${event.type} leaked undefined`).not.toContain('undefined');
      }
    }
  });

  test('a third party still gets third-person verbs', () => {
    expect(summarise({ type: 'matchEnded', winnerId: 'dana' }, ME)).toBe('Player dana wins');
    expect(summarise({ type: 'playerEliminated', playerId: 'dana' }, ME)).toBe(
      'Player dana is out',
    );
    expect(summarise({ type: 'dieLost', playerId: 'dana', diceCount: 2 }, ME)).toBe(
      'Player dana loses a die — 2 left',
    );
  });
});

describe('Subjects and possessives', () => {
  test('the verb follows the person', () => {
    expect(subject('me', 'me', 'opens', 'open')).toBe('You open');
    expect(subject('dana', 'me', 'opens', 'open')).toBe('Player dana opens');
  });

  test('your own things are "your", never "You\'s"', () => {
    expect(possessive('me', 'me')).toBe('your');
    expect(possessive('dana', 'me')).toBe("Player dana's");
  });
});
