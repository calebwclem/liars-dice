/**
 * The table.
 *
 * Zero rules live here. Which faces can be bid and at what quantity comes from
 * `snapshot.bidOptions`, which the server computed with the engine; this only draws buttons and
 * greys out the ones the server has already said are unavailable. CLAUDE.md allows disabling a
 * button for UX and forbids deciding legality, and taking the *answers* from the server rather
 * than the rules is how both hold at once.
 */
import { useEffect, useRef, useState } from 'react';
import type { ErrorCode, Face, MatchSnapshot, ProtocolEvent } from '@liars-dice/protocol';
import { Die, Hand, counts, possessive, shortName, spoken, subject } from './Dice.tsx';
import { TurnRing } from './TurnRing.tsx';
import { atLeast, useRevealBeat, type RevealBeat } from './useRevealBeat.ts';
import { isMuted, playTurnChime, setMuted, setTitleForTurn } from './attention.ts';

const FACES: readonly Face[] = [1, 2, 3, 4, 5, 6];

export function Match({
  snapshot,
  turnDeadline,
  log,
  me,
  lastError,
  bid,
  challenge,
  leave,
}: {
  snapshot: MatchSnapshot;
  turnDeadline: number | null;
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
  const [muted, setMutedState] = useState(isMuted);

  // A reveal is identified by the round it ended, so a new one restarts the sequence and an
  // unrelated snapshot arriving mid-reveal does not rewind it.
  const revealing = phase.kind === 'reveal' ? view.lastReveal : null;
  const beat = useRevealBeat(revealing === null ? null : String(revealing.roundIndex));

  // R-16/R-17: a browser tab is easy to lose behind a video call, and a turn nobody noticed is a
  // turn played for them. Chime once on the transition into your turn, not on every snapshot.
  const wasMyTurn = useRef(false);
  useEffect(() => {
    setTitleForTurn(myTurn);
    if (myTurn && !wasMyTurn.current) playTurnChime();
    wasMyTurn.current = myTurn;
  }, [myTurn]);

  // Leaving the match should not leave the tab shouting about a turn that is over.
  useEffect(
    () => () => {
      setTitleForTurn(false);
    },
    [],
  );

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
        <span className="row" style={{ gap: 2 }}>
          <button
            className="icon-button"
            onClick={() => {
              const next = !muted;
              setMuted(next);
              setMutedState(next);
              if (!next) playTurnChime();
            }}
            aria-pressed={muted}
            aria-label={muted ? 'unmute the turn chime' : 'mute the turn chime'}
            title={muted ? 'Turn chime off' : 'Turn chime on'}
          >
            {muted ? '🔇' : '🔔'}
          </button>
          <button className="quiet" onClick={leave}>
            Leave
          </button>
        </span>
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

      {revealing !== null ? <Reveal reveal={revealing} me={me} beat={beat} /> : null}

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
          <div className="section-label">YOUR HAND</div>
          <Hand
            dice={view.you.dice}
            size={44}
            {...(revealing !== null && atLeast(beat, 'counting')
              ? { countingFace: revealing.bid.face }
              : {})}
          />
        </div>
      ) : null}

      {phase.kind === 'bidding' ? (
        <div className={`turn-row${myTurn ? ' mine' : ''}`}>
          {turnDeadline === null ? (
            <span className="muted small">thinking…</span>
          ) : (
            <TurnRing deadline={turnDeadline} total={snapshot.turnMs} />
          )}
          <span>
            {myTurn ? (
              <strong>Your turn</strong>
            ) : (
              <span className="muted">Waiting for {shortName(phase.turnId, me)}</span>
            )}
            {/* R-17, said before it happens rather than after. */}
            {myTurn && turnDeadline !== null ? (
              <div className="muted small">
                Run out of time and the smallest legal raise is played for you.
              </div>
            ) : null}
          </span>
        </div>
      ) : null}

      {myTurn ? (
        <div className="panel stack">
          <div className="face-picker">
            {FACES.map((candidate) => (
              <button
                key={candidate}
                onClick={() => setFace(candidate)}
                disabled={minFor(candidate) === null}
                style={{
                  border: candidate === face ? '2px solid var(--brass)' : '2px solid transparent',
                }}
                aria-pressed={candidate === face}
                aria-label={spoken(2, candidate)}
              >
                <Die face={candidate} size={32} />
              </button>
            ))}
          </div>

          <div className="row spread stepper">
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
      ) : phase.kind === 'reveal' ? (
        <div className="muted center small">Counting the dice…</div>
      ) : null}

      {lastError !== null ? <div className="error center">{readable(lastError)}</div> : null}

      <div className="feed">
        {[...log].reverse().map((event, index) => (
          <div key={index}>{summarise(event, me)}</div>
        ))}
      </div>
    </>
  );
}

/**
 * R-10: every cup comes up, and only here.
 *
 * Drawn a beat at a time. The hands appear face-down first and turn over together, which is what
 * makes the moment read as cups being lifted rather than a table being redrawn; the dice that
 * count light up a beat later, so you can see the count being made rather than being told it.
 */
export function Reveal({
  reveal,
  me,
  beat,
}: {
  reveal: NonNullable<MatchSnapshot['view']['lastReveal']>;
  me: string | null;
  beat: RevealBeat;
}) {
  return (
    <div className="panel stack">
      <div>
        {subject(reveal.challengerId, me, 'challenged', 'challenged')}{' '}
        {possessive(reveal.bidderId, me)} {spoken(reveal.bid.quantity, reveal.bid.face)}
      </div>
      {Object.entries(reveal.hands).map(([playerId, dice]) => (
        <div key={playerId} className="row" style={{ gap: 10 }}>
          <span className="small reveal-name">{shortName(playerId, me)}</span>
          <span className="row" style={{ gap: 4 }}>
            {dice.map((die, index) => (
              <Die
                key={index}
                {...(atLeast(beat, 'hands') ? { face: die } : { hidden: true })}
                size={26}
                counting={atLeast(beat, 'counting') && counts(die, reveal.bid.face)}
              />
            ))}
          </span>
        </div>
      ))}
      {atLeast(beat, 'verdict') ? (
        <div className="appear">
          {spoken(reveal.actualCount, reveal.bid.face)} —{' '}
          <strong>{reveal.bidStands ? 'the bid was good' : 'the bid was a lie'}</strong>
        </div>
      ) : null}
      {atLeast(beat, 'outcome') ? (
        <div className="muted small appear">
          {subject(reveal.loserId, me, 'loses', 'lose')} a die — {reveal.loserDiceCount} left
          {reveal.eliminatedId !== null
            ? ` · ${subject(reveal.eliminatedId, me, 'is out', 'are out')}`
            : ''}
        </div>
      ) : null}
    </div>
  );
}

export function summarise(event: ProtocolEvent, me: string | null): string {
  const name = (id: string) => shortName(id, me);
  const says = (id: string, third: string, second: string) => subject(id, me, third, second);
  switch (event.type) {
    case 'matchStarted':
      return `Match started — ${String(event.playerIds.length)} players`;
    case 'roundStarted':
      return `Round ${String(event.index + 1)}: ${says(event.starterId, 'opens', 'open')}`;
    case 'bidMade':
      return `${says(event.playerId, 'bids', 'bid')} ${spoken(event.bid.quantity, event.bid.face)}`;
    case 'dudoCalled':
      return `${says(event.playerId, 'challenges', 'challenge')} ${possessive(event.bidderId, me)} bid`;
    case 'diceRevealed':
      return `Revealed: ${spoken(event.reveal.actualCount, event.reveal.bid.face)} — ${
        event.reveal.bidStands ? 'the bid was good' : 'the bid was a lie'
      }`;
    case 'dieLost':
      return `${says(event.playerId, 'loses', 'lose')} a die — ${String(event.diceCount)} left`;
    case 'playerEliminated':
      return says(event.playerId, 'is out', 'are out');
    case 'matchEnded':
      return says(event.winnerId, 'wins', 'win');
    case 'playerTimedOut':
      return event.autoBid === null
        ? `${name(event.playerId)} ran out of time again`
        : `${name(event.playerId)} ran out of time — a minimum raise was played`;
    case 'playerDisconnected':
      return says(event.playerId, 'disconnected', 'disconnected');
    case 'playerReconnected':
      return says(event.playerId, 'is back', 'are back');
    case 'botTookOver':
      return `A bot is playing ${possessive(event.playerId, me)} seat`;
    case 'controlReturned':
      return says(event.playerId, 'has the seat back', 'have the seat back');
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
