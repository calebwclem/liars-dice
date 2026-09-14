/**
 * The reducer. Pure: every answer is a function of `(state, action, ctx)`, and the only
 * time and randomness in the building come from `ctx`.
 *
 * Nothing here mutates `state`. Each branch builds a new object, which is what makes a
 * match replayable from its action list and makes the snapshot a client holds safe to
 * keep — see DECISIONS.md, "Server-authoritative with a pure shared engine".
 */
import type {
  Action,
  Ctx,
  GameEvent,
  GameState,
  PlayerId,
  PlayerState,
  Result,
  RevealSummary,
  Transition,
} from './types.ts';
import { err, ok } from './types.ts';
import { checkBid, countFace } from './bids.ts';
import { isActive, nextActiveAfter, playerById, standingBid } from './query.ts';
import { diceCountsOf, rollHands } from './state.ts';

export function reduce(state: GameState, action: Action, ctx: Ctx): Result<Transition> {
  if (state.phase.kind === 'ended') return err('MATCH_ENDED');

  switch (action.type) {
    case 'bid':
      return applyBid(state, action.playerId, action.bid);
    case 'dudo':
      return applyDudo(state, action.playerId, ctx);
    case 'advanceRound':
      return applyAdvanceRound(state, ctx);
    default: {
      // Exhaustiveness: adding a case to Action without handling it here is a type error.
      const unreachable: never = action;
      return unreachable;
    }
  }
}

/** Shared gate for the two player intents: right phase, real player, their turn. */
function requireTurn(state: GameState, playerId: PlayerId): Result<PlayerState> {
  if (state.phase.kind !== 'bidding') return err('WRONG_PHASE');
  const player = playerById(state, playerId);
  if (player === null) return err('UNKNOWN_PLAYER');
  if (!isActive(player)) return err('PLAYER_ELIMINATED'); // R-12
  if (state.phase.turnId !== playerId) return err('NOT_YOUR_TURN');
  return ok(player);
}

/** R-04 to R-09. */
function applyBid(
  state: GameState,
  playerId: PlayerId,
  bid: GameState['round']['bids'][number]['bid'],
): Result<Transition> {
  const turn = requireTurn(state, playerId);
  if (!turn.ok) return turn;

  const legality = checkBid(state, bid);
  if (!legality.ok) return legality;

  // R-05: the turn passes clockwise to the next player still in the match.
  const next = nextActiveAfter(state, turn.value.seat);

  return ok({
    state: {
      ...state,
      round: { ...state.round, bids: [...state.round.bids, { playerId, bid }] },
      phase: { kind: 'bidding', turnId: next.id },
      seq: state.seq + 1,
    },
    events: [{ type: 'bidMade', playerId, bid }],
  });
}

/**
 * R-10. Reveal, count, and take a die from whoever was wrong. Then R-12 (elimination and
 * victory) and R-13's arming, but *not* the next round: that is `advanceRound`'s job, so
 * that a client reconnecting mid-reveal can still see what happened.
 */
function applyDudo(state: GameState, playerId: PlayerId, ctx: Ctx): Result<Transition> {
  const turn = requireTurn(state, playerId);
  if (!turn.ok) return turn;

  const bid = standingBid(state);
  const bidder = state.round.bids.at(-1);
  if (bid === null || bidder === undefined) return err('OPENING_BID_REQUIRED'); // R-06

  const wildOnes = !state.round.palifico; // R-07, R-13
  const actualCount = countFace(state.round.hands, bid.face, wildOnes);
  const bidStands = actualCount >= bid.quantity; // R-10: "at least"
  const loserId = bidStands ? playerId : bidder.playerId;

  const players = state.players.map((p) =>
    p.id === loserId ? { ...p, diceCount: p.diceCount - 1 } : p,
  );
  const loser = players.find((p) => p.id === loserId);
  if (loser === undefined) return err('UNKNOWN_PLAYER');

  const eliminatedId = loser.diceCount === 0 ? loserId : null; // R-12

  // R-13: the first time a player drops to exactly one die, the next round is theirs and
  // it is a palifico round. Once per match, tracked on the player.
  const armsPalifico = loser.diceCount === 1 && !loser.palificoUsed;
  const withFlags = armsPalifico
    ? players.map((p) => (p.id === loserId ? { ...p, palificoUsed: true } : p))
    : players;

  const reveal: RevealSummary = {
    roundIndex: state.round.index,
    challengerId: playerId,
    bidderId: bidder.playerId,
    bid,
    wildOnes,
    actualCount,
    bidStands,
    hands: state.round.hands,
    loserId,
    loserDiceCount: loser.diceCount,
    eliminatedId,
  };

  const survivors = withFlags.filter(isActive);
  const winner = survivors.length === 1 ? survivors[0] : undefined; // R-12

  const events: GameEvent[] = [
    { type: 'dudoCalled', playerId, bidderId: bidder.playerId, bid },
    { type: 'diceRevealed', reveal },
    { type: 'dieLost', playerId: loserId, diceCount: loser.diceCount },
  ];
  if (eliminatedId !== null) events.push({ type: 'playerEliminated', playerId: eliminatedId });
  if (armsPalifico) events.push({ type: 'palificoArmed', playerId: loserId });
  if (winner !== undefined) events.push({ type: 'matchEnded', winnerId: winner.id });

  return ok({
    state: {
      ...state,
      players: withFlags,
      phase: winner === undefined ? { kind: 'reveal' } : { kind: 'ended', winnerId: winner.id },
      lastReveal: reveal,
      palificoNextFor: armsPalifico ? loserId : null,
      seq: state.seq + 1,
      endedAt: winner === undefined ? state.endedAt : ctx.now,
    },
    events,
  });
}

/**
 * Close the reveal and deal the next round: R-13/R-14/R-15 choose who starts, R-03 rolls.
 *
 * Server-issued only — it is how the server says "the clients have seen the reveal". It
 * must never be accepted from a client.
 */
function applyAdvanceRound(state: GameState, ctx: Ctx): Result<Transition> {
  if (state.phase.kind !== 'reveal') return err('WRONG_PHASE');
  const reveal = state.lastReveal;
  if (reveal === null) return err('WRONG_PHASE');

  const starterId = chooseStarter(state, reveal);
  const palifico = state.palificoNextFor !== null; // R-13
  const hands = rollHands(state.players, ctx.rng); // R-03
  const index = state.round.index + 1;

  return ok({
    state: {
      ...state,
      round: { index, palifico, starterId, hands, bids: [] },
      phase: { kind: 'bidding', turnId: starterId },
      palificoNextFor: null,
      seq: state.seq + 1,
    },
    events: [
      {
        type: 'roundStarted',
        index,
        starterId,
        palifico,
        diceCounts: diceCountsOf(state.players),
      },
    ],
  });
}

/**
 * Who opens the next round.
 *
 * R-13 wins when set, and points at the player who just dropped to one die — which is the
 * same player R-15 would pick, since dropping a die is how they got there. R-14 then
 * covers the case where the die-loser is out of the match altogether.
 */
function chooseStarter(state: GameState, reveal: RevealSummary): PlayerId {
  if (state.palificoNextFor !== null) return state.palificoNextFor; // R-13

  const loser = playerById(state, reveal.loserId);
  if (loser !== null && isActive(loser)) return loser.id; // R-15

  // R-14: the eliminated player's left-hand neighbour, skipping anyone already out.
  const fromSeat = loser?.seat ?? state.players.length - 1;
  return nextActiveAfter(state, fromSeat).id;
}
