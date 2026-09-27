import { describe, expect, test } from 'vitest';
import type { Action, GameState } from '@liars-dice/engine';
import { createMatch, makeRng, redactFor, reduce } from '@liars-dice/engine';
import { decide } from '../src/policy.ts';
import { PROFILES } from '../src/profiles.ts';

/**
 * Bots playing bots, as a regression guard on the shape of the game.
 *
 * None of this asserts that the profiles are *balanced* — they are personalities, not difficulty
 * tiers, and a bold bot losing more often is the honest consequence of playing bold. What it does
 * assert is that none of them is broken: a profile that always folds, always raises, or wins almost
 * never would pass every unit test in `policy.test.ts` and still be unplayable.
 *
 * The bounds are deliberately wide. A tighter assertion on win rate would be a flaky test dressed
 * up as a quality bar; the measured rates live in docs/DECISIONS.md, where moving them is a
 * decision rather than a test failure.
 */
describe('Bots against bots', () => {
  interface Result {
    readonly wins: Map<string, number>;
    readonly matches: number;
    readonly rounds: number;
    readonly bids: number;
    readonly challenges: number;
  }

  function tournament(matches: number): Result {
    const wins = new Map(PROFILES.map((profile) => [profile.name, 0]));
    let rounds = 0;
    let bids = 0;
    let challenges = 0;

    for (let match = 0; match < matches; match += 1) {
      // One seat per profile plus a rotating fourth, so each profile plays every position.
      const seats = [...PROFILES, PROFILES[match % PROFILES.length]!];
      const ids = seats.map((profile, seat) => `${profile.name}@${String(seat)}`);
      const rng = makeRng(match * 7919);
      // A stream per seat: a bot's bluffing must not be correlated with its neighbours'.
      const streams = new Map(
        ids.map((id, seat) => [id, makeRng(match * 104_729 + seat * 1013 + 13)]),
      );

      const opened = createMatch({ matchId: 'M', playerIds: ids }, { now: 0, rng });
      if (!opened.ok) throw new Error(opened.reason);
      let state: GameState = opened.value.state;

      for (let step = 1; state.phase.kind !== 'ended' && step < 20_000; step += 1) {
        let action: Action;
        if (state.phase.kind === 'reveal') {
          action = { type: 'advanceRound' };
        } else {
          const turnId = state.phase.turnId;
          const profile = seats[ids.indexOf(turnId)];
          const stream = streams.get(turnId);
          if (profile === undefined || stream === undefined) throw new Error('unseated player');
          const judgement = decide(redactFor(state, turnId), { profile, rng: stream });
          if (judgement === null) throw new Error(`no decision for ${turnId}`);
          action = judgement.action;
          if (action.type === 'bid') bids += 1;
          else challenges += 1;
        }
        const result = reduce(state, action, { now: step, rng });
        if (!result.ok) throw new Error(`engine refused ${action.type}: ${result.reason}`);
        state = result.value.state;
      }

      expect(state.phase.kind).toBe('ended');
      if (state.phase.kind === 'ended') {
        const name = state.phase.winnerId.split('@')[0] ?? '';
        wins.set(name, (wins.get(name) ?? 0) + 1);
      }
      rounds += state.round.index + 1;
    }

    return { wins, matches, rounds, bids, challenges };
  }

  const result = tournament(120);

  test('every profile wins a real share of its matches', () => {
    // Fair is a third here, since each profile holds one seat of four plus a share of the fourth.
    for (const [name, won] of result.wins) {
      const share = won / result.matches;
      expect(share, `${name} wins ${String(Math.round(share * 100))}% of matches`).toBeGreaterThan(
        0.12,
      );
      expect(share, `${name} wins ${String(Math.round(share * 100))}% of matches`).toBeLessThan(
        0.7,
      );
    }
  });

  test('a match is a game rather than a coin toss', () => {
    // Dice only ever leave the table (R-11), so twenty dice means at most nineteen rounds. Landing
    // near that means rounds are being played rather than conceded on the first bid.
    const perMatch = result.rounds / result.matches;
    expect(perMatch).toBeGreaterThan(10);
    expect(perMatch).toBeLessThanOrEqual(19);
  });

  test('bots mostly bid, and challenge when it is worth it', () => {
    // All-challenge would make every round one move long; all-bid would mean nobody ever calls a
    // lie. Neither is a game.
    const bidShare = result.bids / (result.bids + result.challenges);
    expect(bidShare).toBeGreaterThan(0.5);
    expect(bidShare).toBeLessThan(0.85);
  });

  test('the whole tournament replays identically', () => {
    const again = tournament(20);
    const first = tournament(20);
    expect([...again.wins.entries()]).toEqual([...first.wins.entries()]);
    expect(again.rounds).toBe(first.rounds);
  });
});
