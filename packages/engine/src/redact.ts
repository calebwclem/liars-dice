/**
 * The redaction boundary. CLAUDE.md rule 4: this is the only function allowed to produce
 * client-facing state, and a message must never contain another player's dice before a
 * reveal. Everything a client knows comes from here or from a `GameEvent`, and no event
 * carries a die face except `diceRevealed`.
 *
 * Note what is *absent* from `PlayerView`: `round.hands`. It is not filtered down to the
 * viewer's own entry, it is gone, replaced by `you.dice`. Removing the field rather than
 * pruning it means a future edit cannot accidentally leave a foreign hand behind.
 */
import type { GameState, PlayerId, PlayerView, PublicPlayer } from './types.ts';
import { lockedFace, totalDiceInPlay } from './query.ts';
import { playerById } from './query.ts';

export function redactFor(state: GameState, playerId: PlayerId): PlayerView {
  const self = playerById(state, playerId);
  const players: readonly PublicPlayer[] = state.players.map((p) => ({
    id: p.id,
    seat: p.seat,
    diceCount: p.diceCount,
    eliminated: p.diceCount === 0,
    palificoUsed: p.palificoUsed,
  }));

  return {
    matchId: state.matchId,
    seq: state.seq,
    config: state.config,
    you:
      self === null
        ? null
        : { id: self.id, seat: self.seat, dice: state.round.hands[self.id] ?? [] },
    players,
    phase: state.phase,
    round: {
      index: state.round.index,
      palifico: state.round.palifico,
      starterId: state.round.starterId,
      lockedFace: lockedFace(state),
      bids: state.round.bids,
    },
    // R-10: the one place hands are public. Present only after a challenge has resolved.
    lastReveal: state.lastReveal,
    totalDiceInPlay: totalDiceInPlay(state),
  };
}
