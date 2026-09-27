import { describe, expect, test } from 'vitest';
import {
  bidContextOf,
  bidContextOfView,
  checkBid,
  checkBidIn,
  countFace,
  legalBids,
  legalBidsIn,
  minimumLegalBid,
  minimumLegalBidIn,
  redactFor,
  reduce,
  totalDiceInPlay,
} from '../src/index.ts';
import type { Bid, ErrorReason, Face, GameState } from '../src/types.ts';
import { bid, ctx, expectErr, fourPlayers, makeState, playRandomMatch, unwrap } from './helpers.ts';

/** Four hands that matter to nothing here; only the bid ladder is under test. */
const HANDS: [readonly Face[], readonly Face[], readonly Face[], readonly Face[]] = [
  [1, 2, 3, 4, 5],
  [1, 2, 3, 4, 5],
  [1, 2, 3, 4, 5],
  [1, 2, 3, 4, 5],
];

/** A state where `a` has bid `standing` and it is `b`'s turn. */
const after = (standing: Bid, palifico = false): GameState =>
  fourPlayers(HANDS, { bids: [{ playerId: 'a', bid: standing }], turnId: 'b', palifico });

/** Play `next` as b over the standing bid and report legality. */
const raise = (standing: Bid, next: Bid, palifico = false): true | ErrorReason => {
  const result = reduce(
    after(standing, palifico),
    { type: 'bid', playerId: 'b', bid: next },
    ctx(),
  );
  return result.ok ? true : result.reason;
};

describe('Bidding', () => {
  test('R-04: a bid counts every die still in play, not just the bidder’s', () => {
    const hands = { a: [2, 2] as Face[], b: [2] as Face[], c: [5] as Face[] };
    expect(totalDiceInPlay(makeState({ hands }))).toBe(4);
    expect(countFace(hands, 2, false)).toBe(3);
  });

  test('R-04: quantity must be a positive integer', () => {
    for (const q of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(raise(bid(3, 5), { quantity: q, face: 6 })).toBe('BID_QUANTITY_INVALID');
    }
  });

  test('R-04: quantity may not exceed the total dice in play', () => {
    const state = after(bid(3, 5));
    expect(totalDiceInPlay(state)).toBe(20);
    expect(raise(bid(3, 5), bid(20, 6))).toBe(true);
    expect(raise(bid(3, 5), bid(21, 6))).toBe('BID_EXCEEDS_DICE_IN_PLAY');
  });

  test('R-04: the cap tracks dice lost, not dice dealt at setup', () => {
    const small = makeState({
      hands: { a: [3], b: [4] },
      bids: [{ playerId: 'a', bid: bid(1, 3) }],
      turnId: 'b',
    });
    expect(totalDiceInPlay(small)).toBe(2);
    expect(reduce(small, { type: 'bid', playerId: 'b', bid: bid(2, 4) }, ctx()).ok).toBe(true);
    expectErr(
      reduce(small, { type: 'bid', playerId: 'b', bid: bid(3, 4) }, ctx()),
      'BID_EXCEEDS_DICE_IN_PLAY',
    );
  });

  test('R-02/R-04: face must be an integer 1..6', () => {
    for (const f of [0, 7, 2.5, -1]) {
      expect(raise(bid(3, 5), { quantity: 4, face: f as Face })).toBe('BID_FACE_INVALID');
    }
  });

  test('R-05: the round starter makes the opening bid', () => {
    const state = fourPlayers(HANDS, { starterId: 'c' });
    expect(state.phase).toEqual({ kind: 'bidding', turnId: 'c' });
    expectErr(
      reduce(state, { type: 'bid', playerId: 'd', bid: bid(1, 2) }, ctx()),
      'NOT_YOUR_TURN',
    );
    expect(reduce(state, { type: 'bid', playerId: 'c', bid: bid(1, 2) }, ctx()).ok).toBe(true);
  });

  test('R-05: play proceeds clockwise in fixed seat order', () => {
    let state = fourPlayers(HANDS, { starterId: 'b' });
    const order: string[] = [];
    let quantity = 1;
    for (let i = 0; i < 5; i++) {
      const turnId = state.phase.kind === 'bidding' ? state.phase.turnId : '';
      order.push(turnId);
      state = unwrap(
        reduce(state, { type: 'bid', playerId: turnId, bid: bid(quantity++, 6) }, ctx()),
      ).state;
    }
    expect(order).toEqual(['b', 'c', 'd', 'a', 'b']);
  });

  test('R-05: there is no minimum opening bid beyond validity', () => {
    const state = fourPlayers(HANDS);
    expect(reduce(state, { type: 'bid', playerId: 'a', bid: bid(1, 2) }, ctx()).ok).toBe(true);
    expect(reduce(state, { type: 'bid', playerId: 'a', bid: bid(1, 1) }, ctx()).ok).toBe(true);
    expect(reduce(state, { type: 'bid', playerId: 'a', bid: bid(20, 6) }, ctx()).ok).toBe(true);
  });

  test('R-06: the first player of a round must bid and cannot challenge', () => {
    const state = fourPlayers(HANDS);
    expectErr(reduce(state, { type: 'dudo', playerId: 'a' }, ctx()), 'OPENING_BID_REQUIRED');
  });

  test('R-06: once a bid stands, the next player may raise or challenge', () => {
    const state = after(bid(3, 5));
    expect(reduce(state, { type: 'bid', playerId: 'b', bid: bid(4, 5) }, ctx()).ok).toBe(true);
    expect(reduce(state, { type: 'dudo', playerId: 'b' }, ctx()).ok).toBe(true);
    // There is no third option: `Action` has no pass, so "raise or challenge" is
    // enforced by the type, not by a runtime check.
  });

  test('R-06: a player not on turn can neither bid nor challenge', () => {
    const state = after(bid(3, 5));
    expectErr(
      reduce(state, { type: 'bid', playerId: 'c', bid: bid(4, 5) }, ctx()),
      'NOT_YOUR_TURN',
    );
    expectErr(reduce(state, { type: 'dudo', playerId: 'c' }, ctx()), 'NOT_YOUR_TURN');
    expectErr(
      reduce(state, { type: 'bid', playerId: 'zz', bid: bid(4, 5) }, ctx()),
      'UNKNOWN_PLAYER',
    );
  });

  test('R-07: ones are wild, so a 1 counts toward any face', () => {
    const hands = { a: [1, 1, 4] as Face[], b: [4, 6] as Face[] };
    expect(countFace(hands, 4, true)).toBe(4); // two 4s + two wild ones
    expect(countFace(hands, 6, true)).toBe(3); // one 6 + two wild ones
  });

  test('R-07: a bid on ones counts only the ones themselves', () => {
    const hands = { a: [1, 1, 4] as Face[], b: [4, 6] as Face[] };
    expect(countFace(hands, 1, true)).toBe(2);
  });

  test('R-07: with ones not wild (palifico) a 1 counts only as a one', () => {
    const hands = { a: [1, 1, 4] as Face[], b: [4, 6] as Face[] };
    expect(countFace(hands, 4, false)).toBe(2);
    expect(countFace(hands, 1, false)).toBe(2);
  });
});

describe('R-08 raise legality', () => {
  // Standing bid (3, 5). At least one of quantity or face must rise, and neither may fall.
  const cases: [Bid, true | ErrorReason, string][] = [
    [bid(3, 6), true, 'same quantity, higher face'],
    [bid(4, 5), true, 'same face, higher quantity'],
    [bid(4, 6), true, 'both higher'],
    [bid(4, 2), true, 'higher quantity, LOWER face — legal, the amended R-08 case'],
    [bid(4, 3), true, 'higher quantity, lower face'],
    [bid(20, 2), true, 'far higher quantity, lower face, at the cap'],
    [bid(3, 5), 'BID_TOO_LOW', 'identical to the standing bid'],
    [bid(3, 4), 'BID_TOO_LOW', 'same quantity, lower face'],
    [bid(2, 6), 'BID_TOO_LOW', 'lower quantity, higher face'],
    [bid(2, 5), 'BID_TOO_LOW', 'lower quantity, same face'],
  ];

  for (const [next, expected, why] of cases) {
    test(`R-08: (3,5) -> (${String(next.quantity)},${String(next.face)}) — ${why}`, () => {
      expect(raise(bid(3, 5), next)).toBe(expected);
    });
  }

  test('R-08: raising the quantity frees the face entirely', () => {
    for (const face of [1, 2, 3, 4, 5, 6] as Face[]) {
      // (4, 1) is a ones bid and so is governed by R-09, which allows any quantity
      // at or above ceil(3/2) = 2; 4 clears that too.
      expect(raise(bid(3, 5), bid(4, face))).toBe(true);
    }
  });

  test('R-08: face 6 is the ceiling, so only quantity can rise from (q,6)', () => {
    expect(raise(bid(3, 6), bid(4, 6))).toBe(true);
    expect(raise(bid(3, 6), bid(4, 1))).toBe(true); // quantity up frees the face
    expect(raise(bid(3, 6), bid(3, 6))).toBe('BID_TOO_LOW');
    expect(raise(bid(3, 6), bid(2, 1))).toBe('BID_TOO_LOW'); // no conversion any more
  });
});

describe('R-09 ones have no special standing in bidding', () => {
  test('R-09: switching to ones costs exactly what switching to any other face costs', () => {
    // No halved quantity. From (5,3) the only way onto ones is to raise the quantity, because
    // face 1 is below face 3 — the same as it would be for twos.
    expect(raise(bid(5, 3), bid(6, 1))).toBe(true);
    expect(raise(bid(5, 3), bid(5, 1))).toBe('BID_TOO_LOW');
    expect(raise(bid(5, 3), bid(3, 1))).toBe('BID_TOO_LOW');
    expect(raise(bid(5, 3), bid(2, 1))).toBe('BID_TOO_LOW');
    expect(raise(bid(5, 3), bid(6, 2))).toBe(true);
  });

  test('R-09: leaving ones costs exactly what leaving any other face costs', () => {
    // No doubling. From (3,1) a higher face at the same quantity is enough, because ones are
    // the lowest face and nothing special.
    expect(raise(bid(3, 1), bid(3, 2))).toBe(true);
    expect(raise(bid(3, 1), bid(3, 6))).toBe(true);
    expect(raise(bid(3, 1), bid(4, 1))).toBe(true);
    expect(raise(bid(3, 1), bid(2, 6))).toBe('BID_TOO_LOW');
    expect(raise(bid(3, 1), bid(3, 1))).toBe('BID_TOO_LOW');
  });

  test('R-09: ones sit below every other face at the same quantity', () => {
    for (const face of [2, 3, 4, 5, 6] as Face[]) {
      // Up from ones is a raise...
      expect(raise(bid(4, 1), bid(4, face))).toBe(true);
      // ...and down to ones is not.
      expect(raise(bid(4, face), bid(4, 1))).toBe('BID_TOO_LOW');
    }
  });

  test('R-09: a ones bid is never cheaper than the face above it', () => {
    // The point of the amendment, stated as a test: there is no quantity at which switching to
    // ones undercuts the ladder. Bidding ones is a weak move, never a cheap one.
    const dice = totalDiceInPlay(after(bid(4, 3)));
    for (let quantity = 1; quantity <= dice; quantity += 1) {
      const onesLegal = raise(bid(4, 3), bid(quantity, 1)) === true;
      const twosLegal = raise(bid(4, 3), bid(quantity, 2)) === true;
      // Anything legal on ones is legal on twos too, so ones can never be the cheaper route.
      expect(!onesLegal || twosLegal).toBe(true);
    }
  });

  test('R-04/R-08: at the cap on sixes there is no legal raise left', () => {
    // The only dead end left once the conversions are gone: the top of the ladder.
    const state = makeState({
      hands: { a: [1], b: [1] },
      bids: [{ playerId: 'a', bid: bid(2, 6) }],
      turnId: 'b',
    });
    expect(totalDiceInPlay(state)).toBe(2);
    expect(legalBids(state)).toEqual([]);
    expect(minimumLegalBid(state)).toBeNull();
    expect(reduce(state, { type: 'bid', playerId: 'b', bid: bid(3, 6) }, ctx()).ok).toBe(false);
    // Challenging is the only remaining move, and it must work.
    expect(reduce(state, { type: 'dudo', playerId: 'b' }, ctx()).ok).toBe(true);
  });
});

describe('Bid ordering helpers', () => {
  test('R-08: minimumLegalBid opens at (1,1), the weakest bid in the game', () => {
    // One of the lowest face. With R-09 gone the ordering is plain: ones are simply the bottom.
    expect(minimumLegalBid(fourPlayers(HANDS))).toEqual(bid(1, 1));
  });

  test('R-08: legalBids lists every legal raise, weakest first', () => {
    // Standing (19,6) with 20 dice on the table. Only quantity 20 clears it, at any face.
    expect(legalBids(after(bid(19, 6)))).toEqual([
      bid(20, 1),
      bid(20, 2),
      bid(20, 3),
      bid(20, 4),
      bid(20, 5),
      bid(20, 6),
    ]);
  });

  test('R-08: the cheapest raise is one more of the lowest face', () => {
    expect(minimumLegalBid(after(bid(19, 6)))).toEqual(bid(20, 1));
    // And mid-ladder, the cheapest raise is the next face up at the same quantity.
    expect(minimumLegalBid(after(bid(4, 3)))).toEqual(bid(4, 4));
  });

  test('R-08: every bid legalBids offers is accepted by reduce, and no other is', () => {
    const state = after(bid(4, 3));
    const legal = new Set(legalBids(state).map((b) => `${String(b.quantity)}:${String(b.face)}`));
    for (let q = 1; q <= totalDiceInPlay(state); q++) {
      for (const f of [1, 2, 3, 4, 5, 6] as Face[]) {
        const accepted = reduce(state, { type: 'bid', playerId: 'b', bid: bid(q, f) }, ctx()).ok;
        expect(accepted, `(${String(q)},${String(f)})`).toBe(
          legal.has(`${String(q)}:${String(f)}`),
        );
      }
    }
  });
});

describe('Bid legality from a redacted view', () => {
  test('R-04..R-09/R-13: a PlayerView answers exactly as the full state does', () => {
    // A client holds a PlayerView and may grey out an illegal button (CLAUDE.md). That is
    // only safe if the view-derived context gives the same answer as the server's, for
    // every bid — including the quantity cap and the palifico face lock, which are the
    // two places the view could plausibly fall short.
    const { states } = playRandomMatch({ seed: 21, playerIds: ['a', 'b', 'c', 'd'] });
    let checked = 0;
    for (const state of states) {
      const viewer = state.phase.kind === 'bidding' ? state.phase.turnId : 'a';
      const fromView = bidContextOfView(redactFor(state, viewer));
      expect(fromView).toEqual(bidContextOf(state));
      for (let quantity = 1; quantity <= totalDiceInPlay(state) + 1; quantity += 1) {
        for (const face of [1, 2, 3, 4, 5, 6] as Face[]) {
          const candidate = bid(quantity, face);
          expect(checkBidIn(fromView, candidate)).toEqual(checkBid(state, candidate));
          checked += 1;
        }
      }
      expect(legalBidsIn(fromView)).toEqual(legalBids(state));
      expect(minimumLegalBidIn(fromView)).toEqual(minimumLegalBid(state));
    }
    expect(checked).toBeGreaterThan(1_000); // the sweep actually swept
  });

  test('R-13: the view carries the locked face, so a client can enforce it too', () => {
    const state = makeState({
      hands: { a: [1, 2], b: [3, 4] },
      palifico: true,
      starterId: 'a',
      bids: [{ playerId: 'a', bid: bid(2, 3) }],
      turnId: 'b',
    });
    const ctxFromView = bidContextOfView(redactFor(state, 'b'));
    expect(ctxFromView.lockedFace).toBe(3);
    expect(ctxFromView.palifico).toBe(true);
    expect(checkBidIn(ctxFromView, bid(3, 4))).toEqual({
      ok: false,
      reason: 'PALIFICO_FACE_LOCKED',
    });
    expect(checkBidIn(ctxFromView, bid(3, 3))).toEqual({ ok: true, value: true });
  });
});
