/**
 * The table.
 *
 * Zero rules live here. Which faces can be bid and at what quantity comes from
 * `snapshot.bidOptions`, which the server computed with the engine; this only draws buttons and
 * greys out the ones the server has already said are unavailable. CLAUDE.md allows disabling a
 * button for UX and forbids deciding legality, and taking the *answers* from the server rather
 * than the rules is how both hold at once.
 */
import { useEffect, useState } from 'react';
import type { ErrorCode, Face, MatchSnapshot, ProtocolEvent } from '@liars-dice/protocol';
import { Die, Hand, counts, shortName, spoken } from './Dice.tsx';

const FACES: readonly Face[] = [1, 2, 3, 4, 5, 6];

export function Match({
  snapshot,
  log,
  me,
  lastError,
  bid,
  challenge,
  leave,
}: {
  snapshot: MatchSnapshot;
  log: readonly ProtocolEvent[];
  me: string | null;
  lastError: ErrorCode | null;
  bid: (quantity: number, face: number) => void;
  challenge: () => void;
  leave: () => void;
}) {
  const { view, bidOptions } = snapshot;
  const { phase, round } = view;
  const standing = round.bids.at(-1)?.bid ?? null;
  const myTurn = phase.kind === 'bidding' && phase.turnId === view.you?.id;

  const [face, setFace] = useState<Face>(6);
  const [quantity, setQuantity] = useState(1);

  const minFor = (candidate: Face): number | null =>
    bidOptions?.options.find((option) => option.face === candidate)?.minQuantity ?? null;
  const max = bidOptions?.maxQuantity ?? 0;
  const min = minFor(face);

  // Whenever the server's answers change, pull the draft back into what it will now accept. The
  // alternative is a picker that looks fine and produces a bid the server refuses.
  useEffect(() => {
    if (bidOptions === null) return;
    const biddable = FACES.filter((candidate) => minFor(candidate) !== null);
    const chosen = biddable.includes(face) ? face : (biddable[0] ?? face);
    if (chosen !== face) setFace(chosen);
    const floor = minFor(chosen);
    if (floor !== null) setQuantity((current) => Math.min(max, Math.max(floor, current)));
    // Deliberately keyed on `bidOptions` alone: this effect reacts to the server changing its
    // mind about what is legal, not to the player moving the picker.
  }, [bidOptions]);

  const canBid = myTurn && min !== null && quantity >= min && quantity <= max;
  // R-06: whoever opens the round must bid, so there is nothing to challenge yet.
  const canChallenge = myTurn && standing !== null;

  return (
    <>
      <div className="row spread">
        <div>
          <h2>Round {round.index + 1}</h2>
          <div className="muted small">
            {view.totalDiceInPlay === 1
              ? '1 die in play'
              : `${String(view.totalDiceInPlay)} dice in play`}{' '}
            · ones are wild
          </div>
        </div>
        <button className="quiet" onClick={leave}>
          Leave
        </button>
      </div>

      <div className="panel stack">
        {view.players.map((player) => {
          const turn = phase.kind === 'bidding' && phase.turnId === player.id;
          const seat = snapshot.seats.find((entry) => entry.playerId === player.id);
          return (
            <div
              key={player.id}
              className={`seat${turn ? ' turn' : ''}${player.eliminated ? ' out' : ''}`}
            >
              <span style={{ flex: 1 }}>
                {shortName(player.id, me)}
                {seat?.control === 'bot' && !player.id.startsWith('bot_') ? ' (bot)' : ''}
                {seat?.connected === false ? ' · away' : ''}
              </span>
              <span className="row" style={{ gap: 3 }}>
                {player.eliminated ? (
                  <span className="muted small">out</span>
                ) : (
                  Array.from({ length: player.diceCount }, (_, index) => (
                    <Die key={index} hidden size={14} />
                  ))
                )}
              </span>
            </div>
          );
        })}
      </div>

      {standing !== null && phase.kind === 'bidding' ? (
        <div className="panel row" style={{ gap: 10 }}>
          <span className="muted small">on the table</span>
          <strong style={{ fontSize: 22 }}>{standing.quantity}</strong>
          <span className="muted">×</span>
          <Die face={standing.face} size={26} />
        </div>
      ) : null}

      {phase.kind === 'reveal' && view.lastReveal !== null ? (
        <Reveal reveal={view.lastReveal} me={me} />
      ) : null}

      {phase.kind === 'ended' ? (
        <div className="panel center stack">
          <h2>
            {phase.winnerId === view.you?.id
              ? 'You win.'
              : `${shortName(phase.winnerId, me)} wins.`}
          </h2>
          <button className="primary" onClick={leave}>
            Back to the lobby
          </button>
        </div>
      ) : null}

      {view.you !== null ? (
        <div className="stack">
          <div className="muted small">YOUR HAND</div>
          <Hand
            dice={view.you.dice}
            size={44}
            {...(phase.kind === 'reveal' && view.lastReveal !== null
              ? { countingFace: view.lastReveal.bid.face }
              : {})}
          />
        </div>
      ) : null}

      {myTurn ? (
        <div className="panel stack">
          <div className="row wrap" style={{ gap: 6 }}>
            {FACES.map((candidate) => (
              <button
                key={candidate}
                onClick={() => setFace(candidate)}
                disabled={minFor(candidate) === null}
                style={{
                  padding: 6,
                  border: candidate === face ? '2px solid var(--brass)' : '2px solid transparent',
                }}
                aria-pressed={candidate === face}
                aria-label={spoken(2, candidate)}
              >
                <Die face={candidate} size={32} />
              </button>
            ))}
          </div>

          <div className="row spread">
            <button
              onClick={() => setQuantity((q) => Math.max(min ?? 1, q - 1))}
              disabled={min === null || quantity <= min}
              aria-label="fewer"
            >
              −
            </button>
            <strong style={{ fontSize: 26 }}>{min === null ? '—' : spoken(quantity, face)}</strong>
            <button
              onClick={() => setQuantity((q) => Math.min(max, q + 1))}
              disabled={quantity >= max}
              aria-label="more"
            >
              +
            </button>
          </div>

          <div className="row" style={{ gap: 10 }}>
            <button
              className="primary"
              style={{ flex: 1 }}
              disabled={!canBid}
              onClick={() => bid(quantity, face)}
            >
              Bid
            </button>
            <button
              className="danger"
              style={{ flex: 1 }}
              disabled={!canChallenge}
              onClick={challenge}
            >
              Challenge
            </button>
          </div>
          {min === null ? (
            <div className="muted small center">
              Nothing left to bid — the table is at its ceiling. Challenge.
            </div>
          ) : null}
        </div>
      ) : (
        <div className="muted center small">
          {phase.kind === 'bidding'
            ? `Waiting for ${shortName(phase.turnId, me)}…`
            : phase.kind === 'reveal'
              ? 'Counting the dice…'
              : ''}
        </div>
      )}

      {lastError !== null ? <div className="error center">{readable(lastError)}</div> : null}

      <div className="feed">
        {[...log].reverse().map((event, index) => (
          <div key={index}>{summarise(event, me)}</div>
        ))}
      </div>
    </>
  );
}

/** R-10: every cup comes up, and only here. */
function Reveal({
  reveal,
  me,
}: {
  reveal: NonNullable<MatchSnapshot['view']['lastReveal']>;
  me: string | null;
}) {
  return (
    <div className="panel stack">
      <div>
        <strong>{shortName(reveal.challengerId, me)}</strong> challenged{' '}
        <strong>{shortName(reveal.bidderId, me)}</strong>&rsquo;s{' '}
        {spoken(reveal.bid.quantity, reveal.bid.face)}
      </div>
      {Object.entries(reveal.hands).map(([playerId, dice]) => (
        <div key={playerId} className="row" style={{ gap: 10 }}>
          <span className="small" style={{ width: 92 }}>
            {shortName(playerId, me)}
          </span>
          <span className="row" style={{ gap: 4 }}>
            {dice.map((die, index) => (
              <Die key={index} face={die} size={26} counting={counts(die, reveal.bid.face)} />
            ))}
          </span>
        </div>
      ))}
      <div>
        {spoken(reveal.actualCount, reveal.bid.face)} —{' '}
        <strong>{reveal.bidStands ? 'the bid was good' : 'the bid was a lie'}</strong>
      </div>
      <div className="muted small">
        {shortName(reveal.loserId, me)} loses a die — {reveal.loserDiceCount} left
        {reveal.eliminatedId !== null ? ` · ${shortName(reveal.eliminatedId, me)} is out` : ''}
      </div>
    </div>
  );
}

function summarise(event: ProtocolEvent, me: string | null): string {
  const name = (id: string) => shortName(id, me);
  switch (event.type) {
    case 'matchStarted':
      return `Match started — ${String(event.playerIds.length)} players`;
    case 'roundStarted':
      return `Round ${String(event.index + 1)}: ${name(event.starterId)} opens`;
    case 'bidMade':
      return `${name(event.playerId)} bid ${spoken(event.bid.quantity, event.bid.face)}`;
    case 'dudoCalled':
      return `${name(event.playerId)} challenged ${name(event.bidderId)}`;
    case 'diceRevealed':
      return `Revealed: ${spoken(event.reveal.actualCount, event.reveal.bid.face)} — ${
        event.reveal.bidStands ? 'the bid was good' : 'the bid was a lie'
      }`;
    case 'dieLost':
      return `${name(event.playerId)} lost a die — ${String(event.diceCount)} left`;
    case 'playerEliminated':
      return `${name(event.playerId)} is out`;
    case 'matchEnded':
      return `${name(event.winnerId)} wins`;
    case 'playerTimedOut':
      return event.autoBid === null
        ? `${name(event.playerId)} ran out of time again`
        : `${name(event.playerId)} ran out of time — a minimum raise was played`;
    case 'playerDisconnected':
      return `${name(event.playerId)} disconnected`;
    case 'playerReconnected':
      return `${name(event.playerId)} is back`;
    case 'botTookOver':
      return `A bot is playing ${name(event.playerId)}'s seat`;
    case 'controlReturned':
      return `${name(event.playerId)} has the seat back`;
    case 'matchAbandoned':
      return 'Match abandoned — everyone left';
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

export function readable(code: ErrorCode): string {
  switch (code) {
    case 'BID_TOO_LOW':
      return 'That bid does not raise the current one.';
    case 'BID_EXCEEDS_DICE_IN_PLAY':
      return 'There are not that many dice on the table.';
    case 'OPENING_BID_REQUIRED':
      return 'You open the round, so you have to bid.';
    case 'NOT_YOUR_TURN':
      return 'It is not your turn.';
    case 'SEAT_NOT_YOURS':
      return 'A bot is playing your seat.';
    case 'RATE_LIMITED':
      return 'Slow down a moment.';
    case 'UNKNOWN_PARTY':
      return 'No game with that code. Check it and try again.';
    case 'PARTY_FULL':
      return 'That game is full.';
    case 'ALREADY_IN_PARTY':
      return 'You are already in a private game.';
    case 'NOT_PARTY_HOST':
      return 'Only the player who created the game can start it.';
    case 'PARTY_TOO_SMALL':
      return 'You need at least one other player to start.';
    case 'UNKNOWN_MATCH':
    case 'NOT_IN_MATCH':
      return 'That match has finished.';
    default:
      return `The server refused that: ${code}`;
  }
}
