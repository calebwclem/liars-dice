import { describe, expect, test } from 'vitest';
import type { ProtocolEvent } from '@liars-dice/protocol';
import { feedRows, summarise } from '../src/ui/Match.tsx';
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

/**
 * The feed, grouped.
 *
 * Flat, it is a wall of sentences with nothing to say which round any of them belonged to. The
 * rows come out chronological; the DOM order is the view's problem, not this function's.
 */
describe('The feed is broken into rounds', () => {
  const round = (index: number, starterId: string): ProtocolEvent => ({
    type: 'roundStarted',
    index,
    starterId,
    diceCounts: { [starterId]: 5 },
  });
  const bid = (playerId: string, quantity: number): ProtocolEvent => ({
    type: 'bidMade',
    playerId,
    bid: { quantity, face: 6 },
  });

  test('every round opens a section, in the order they were played', () => {
    const rows = feedRows(
      [
        { type: 'matchStarted', playerIds: [ME, 'dana'], startingDice: 5 },
        round(0, ME),
        bid(ME, 1),
        round(1, 'dana'),
        bid('dana', 2),
      ],
      ME,
    );
    expect(rows.filter((row) => row.kind === 'round').map((row) => row.label)).toEqual([
      'Round 1',
      'Round 2',
    ]);
    expect(rows.map((row) => (row.kind === 'round' ? `[${row.label}]` : row.text))).toEqual([
      'Match started — 2 players',
      '[Round 1]',
      'You open',
      'You bid 1 six',
      '[Round 2]',
      'Player dana opens',
      'Player dana bids 2 sixes',
    ]);
  });

  test('the separator numbers the round, so the line under it does not say it twice', () => {
    const rows = feedRows([round(2, ME)], ME);
    expect(rows).toEqual([
      { kind: 'round', label: 'Round 3' },
      { kind: 'line', text: 'You open' },
    ]);
    // Pulled out on its own, though, a line still has to stand up by itself.
    expect(summarise(round(2, ME), ME)).toBe('Round 3: You open');
  });

  test('what happened before the first round is not orphaned', () => {
    // A resync can start the log mid-match, and a match starts before any round does.
    const rows = feedRows([{ type: 'matchStarted', playerIds: [ME], startingDice: 5 }], ME);
    expect(rows).toEqual([{ kind: 'line', text: 'Match started — 1 players' }]);
  });

  test('every event still says something, grouped', () => {
    for (const row of feedRows(everyEvent(ME), ME)) {
      const said = row.kind === 'round' ? row.label : row.text;
      expect(said.length).toBeGreaterThan(0);
      expect(said).not.toContain('undefined');
    }
  });
});
