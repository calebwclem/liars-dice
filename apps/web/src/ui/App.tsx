/**
 * Which screen. Every branch is a stage the session can actually be in, so an unhandled state is
 * a type error rather than a blank page.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { PROTOCOL_VERSION } from '@liars-dice/protocol';
import { Session, isCompleteCode, normaliseCode, type PartyState } from '../session.ts';
import { Match, readable } from './Match.tsx';
import { shortName } from './Dice.tsx';

export function App() {
  // One session for the life of the page. `useSyncExternalStore` is React's supported way to
  // read a store that lives outside React — which this one deliberately does.
  const session = useMemo(() => new Session(), []);
  const state = useSyncExternalStore(session.subscribe, session.getState);

  useEffect(() => {
    session.connect();
    return () => session.disconnect();
  }, [session]);

  const [joining, setJoining] = useState(false);

  return (
    <div className="app">
      {state.reconnecting ? (
        <div className="banner">Reconnecting — your seat is held for a moment</div>
      ) : null}

      {(() => {
        switch (state.stage.kind) {
          case 'connecting':
            return <Message title="Shaking the cups…" detail="Connecting to the table." />;

          case 'lobby':
            return joining ? (
              <JoinParty
                join={(code) => {
                  session.joinParty(code);
                  setJoining(false);
                }}
                cancel={() => setJoining(false)}
                lastError={state.lastError}
              />
            ) : (
              <Lobby
                findMatch={() => session.findMatch()}
                createParty={() => session.createParty()}
                showJoin={() => setJoining(true)}
                lastError={state.lastError}
              />
            );

          case 'queued':
            return (
              <Message
                title="Waiting for players"
                detail={`${String(state.stage.waiting)} of ${String(state.stage.target)} seats filled. Bots sit in shortly so you are not left waiting.`}
              >
                <button className="quiet" onClick={() => session.cancelQueue()}>
                  Leave the queue
                </button>
              </Message>
            );

          case 'party':
            return (
              <Party
                party={state.stage.party}
                me={state.playerId}
                start={(fill) => session.startParty(fill)}
                leave={() => session.leaveParty()}
                lastError={state.lastError}
              />
            );

          case 'playing':
            return state.snapshot === null ? (
              <Message title="Dealing…" detail="Waiting for the first roll." />
            ) : (
              <Match
                snapshot={state.snapshot}
                turnDeadline={state.turnDeadline}
                log={state.log}
                me={state.playerId}
                lastError={state.lastError}
                bid={(quantity, face) => session.bid(quantity, face)}
                challenge={() => session.challenge()}
                leave={() => session.leaveMatch()}
              />
            );

          case 'needsUpdate':
            return (
              <Message
                title="Time to update"
                detail={`This page speaks protocol ${String(PROTOCOL_VERSION)} and the table speaks ${String(state.stage.serverVersion)}. Reload to pick up the new version.`}
              >
                <button className="primary" onClick={() => window.location.reload()}>
                  Reload
                </button>
              </Message>
            );

          case 'failed':
            return (
              <Message title="Cannot reach the table" detail={state.stage.reason}>
                <button className="primary" onClick={() => window.location.reload()}>
                  Try again
                </button>
              </Message>
            );

          default: {
            const unreachable: never = state.stage;
            return unreachable;
          }
        }
      })()}
    </div>
  );
}

function Message({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="stack center" style={{ marginTop: '18vh', gap: 14 }}>
      <h2>{title}</h2>
      <div className="muted">{detail}</div>
      {children}
    </div>
  );
}

function Lobby({
  findMatch,
  createParty,
  showJoin,
  lastError,
}: {
  findMatch: () => void;
  createParty: () => void;
  showJoin: () => void;
  lastError: string | null;
}) {
  return (
    <div className="stack center" style={{ marginTop: '12vh', gap: 16 }}>
      <h1>Liar&rsquo;s Dice</h1>
      <div className="muted">Five dice each. Everyone bids on what the whole table is hiding.</div>
      <button className="primary" onClick={findMatch}>
        Find a match
      </button>
      <div className="row" style={{ justifyContent: 'center' }}>
        <button onClick={createParty}>Play with friends</button>
        <button onClick={showJoin}>Join with a code</button>
      </div>
      {lastError !== null ? <div className="error">{readable(lastError as never)}</div> : null}
    </div>
  );
}

/**
 * The private game. Its one job is to make the code easy to read out loud — everything else on
 * this screen is secondary to somebody saying four characters down a call.
 */
function Party({
  party,
  me,
  start,
  leave,
  lastError,
}: {
  party: PartyState;
  me: string | null;
  start: (fillWithBots: boolean) => void;
  leave: () => void;
  lastError: string | null;
}) {
  const [fillWithBots, setFillWithBots] = useState(true);
  const [copied, setCopied] = useState(false);
  const isHost = party.hostId === me;
  const canStart = party.members.length >= party.minSize;

  const share = async () => {
    // The link is the whole point of the web client: the code alone needs explaining, a URL
    // does not. `clipboard` can be refused, in which case the code is still on screen.
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/#${party.code}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      /* the code is visible above; nothing else to do */
    }
  };

  return (
    <div className="stack" style={{ marginTop: '6vh', gap: 18 }}>
      <div className="center muted small">ROOM CODE</div>
      <div className="code">
        {[...party.code].map((character, index) => (
          <span key={index}>{character}</span>
        ))}
      </div>
      <div className="center">
        <button className="quiet" onClick={() => void share()}>
          {copied ? 'Link copied' : 'Copy invite link'}
        </button>
      </div>

      <div className="panel stack">
        <div className="muted small">AT THE TABLE</div>
        {party.members.map((member) => (
          <div key={member} className="seat">
            <span style={{ flex: 1 }}>{shortName(member, me)}</span>
            {member === party.hostId ? <span className="muted small">host</span> : null}
          </div>
        ))}
        {Array.from({ length: party.maxSize - party.members.length }, (_, index) => (
          <div key={`empty-${String(index)}`} className="seat out">
            <span className="muted">empty</span>
          </div>
        ))}
      </div>

      {isHost ? (
        <div className="stack">
          <label className="row">
            <input
              type="checkbox"
              checked={fillWithBots}
              onChange={(event) => setFillWithBots(event.target.checked)}
              disabled={party.members.length >= party.maxSize}
            />
            <span>Fill empty seats with bots</span>
          </label>
          <button className="primary" disabled={!canStart} onClick={() => start(fillWithBots)}>
            {canStart ? 'Start the match' : 'Waiting for one more'}
          </button>
        </div>
      ) : (
        <div className="center muted">
          Waiting for {shortName(party.hostId, me)} to start the match.
        </div>
      )}

      <div className="center">
        <button className="quiet" onClick={leave}>
          Leave
        </button>
      </div>
      {lastError !== null ? (
        <div className="error center">{readable(lastError as never)}</div>
      ) : null}
    </div>
  );
}

/**
 * Where a code gets typed.
 *
 * The field normalises as you type — uppercasing, dropping anything outside the alphabet — so
 * pasting a code with a stray space never produces "bad message". Strictness lives on the wire;
 * leniency lives here.
 */
function JoinParty({
  join,
  cancel,
  lastError,
}: {
  join: (code: string) => void;
  cancel: () => void;
  lastError: string | null;
}) {
  // An invite link carries the code in the fragment, so arriving that way pre-fills it.
  const [typed, setTyped] = useState(() => normaliseCode(window.location.hash.slice(1)));

  return (
    <div className="stack center" style={{ marginTop: '14vh', gap: 16 }}>
      <h2>Join a private game</h2>
      <div className="muted">Ask whoever set it up for the four-character code.</div>
      <input
        className="code-field"
        value={typed}
        autoFocus
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        placeholder="CODE"
        onChange={(event) => setTyped(normaliseCode(event.target.value))}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && isCompleteCode(typed)) join(typed);
        }}
      />
      <button className="primary" disabled={!isCompleteCode(typed)} onClick={() => join(typed)}>
        Join
      </button>
      <button className="quiet" onClick={cancel}>
        Cancel
      </button>
      {lastError !== null ? <div className="error">{readable(lastError as never)}</div> : null}
    </div>
  );
}
