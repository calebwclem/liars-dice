import { describe, expect, test } from 'vitest';
import { minimumLegalBid } from '../src/index.ts';
import { bid, fourPlayers, makeState } from './helpers.ts';
import type { Face } from '../src/types.ts';

/**
 * Timing and connection state belong to Phase 2's server (see DECISIONS.md, "Timing and
 * disconnection rules deferred to Phase 2"). The rule IDs are named here so that the
 * coverage check in coverage.test.ts can see them and report them as what they are —
 * declared, not implemented. They are the only rules in docs/RULES.md that the engine
 * does not enforce.
 */
describe('Deferred to Phase 2 — the server owns the clock and the sockets', () => {
  test.todo('R-16: each turn has a 30-second timer, enforced server-side');
  test.todo(
    'R-17: the first timeout plays the minimum legal raise; a second consecutive timeout hands the seat to a bot',
  );
  test.todo('R-18: a disconnected player has 45 seconds to reconnect before a bot takes over');
  test.todo('R-19: a match with no connected humans is abandoned and recorded as such');
  test.todo('R-21: provable fairness — the document marks it v1.1, and the brief defers it');

  test('the minimum legal raise is a rules question, so the engine answers it', () => {
    // What the Phase 2 auto-bid calls. (1,1) is the weakest bid in the game: the lowest
    // quantity of the lowest face.
    expect(minimumLegalBid(fourPlayers([[1], [2], [3], [4]]))).toEqual(bid(1, 1));

    const standing = makeState({
      hands: { a: [1, 2, 3] as Face[], b: [4, 5, 6] as Face[] },
      bids: [{ playerId: 'a', bid: bid(3, 4) }],
      turnId: 'b',
    });
    // Over (3,4) the cheapest raise is (3,5) — one face up at the same quantity.
    expect(minimumLegalBid(standing)).toEqual(bid(3, 5));
  });
});
