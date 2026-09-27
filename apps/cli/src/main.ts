/**
 * A terminal client: one human against the bots, playing a full match with no server involved.
 *
 * It owns stdio, the clock and the seed, which is why it lives in `apps/` rather than inside the
 * engine — the engine is a pure library with zero dependencies, and this has both a dependency and
 * a great many side effects.
 *
 * Everything the human is shown comes from `redactFor`, never from `GameState`. So does every bot
 * decision: each is handed its own redacted view, exactly as the server does it, so a bot at this
 * table can no more see your dice than one on the server can.
 *
 * Dice come from a seeded PRNG so a match can be replayed from its seed. R-20 requires a
 * CSPRNG server-side; this is a practice client, not the server.
 *
 *   pnpm cli                      play against 3 bots
 *   pnpm cli -- --players 6       a six-handed match (R-01)
 *   pnpm cli -- --seed 42         reproduce a specific match
 *   pnpm cli -- --auto            let a bot play your seat too, for a quick smoke test
 */
import { createInterface } from 'node:readline';
import { argv, exit, stdin, stdout } from 'node:process';
import type {
  Action,
  Bid,
  Face,
  GameState,
  PlayerId,
  PlayerView,
  RevealSummary,
} from '@liars-dice/engine';
import {
  createMatch,
  legalBids,
  makeRng,
  minimumLegalBid,
  redactFor,
  reduce,
  totalDiceInPlay,
} from '@liars-dice/engine';
import { decide, profileFor, type BotProfile } from '@liars-dice/bots';

const HUMAN = 'You';
const PIPS = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'] as const;

const ESC = '\u001b';
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const RESET = `${ESC}[0m`;
const GREEN = `${ESC}[32m`;
const RED = `${ESC}[31m`;
const YELLOW = `${ESC}[33m`;
const CYAN = `${ESC}[36m`;

const die = (face: Face): string => PIPS[face - 1] ?? String(face);
/** "Bot 1 loses a die" but "You lose a die" — the human's seat is named in second person. */
const conj = (id: PlayerId, third: string, second: string): string =>
  id === HUMAN ? second : third;
const hand = (dice: readonly Face[]): string => dice.map(die).join(' ');
const bidText = (b: Bid): string =>
  `${String(b.quantity)} × ${die(b.face)} ${DIM}(${String(b.face)}s)${RESET}`;
const say = (line = ''): void => {
  console.log(line);
};

interface Options {
  readonly players: number;
  readonly seed: number;
  readonly auto: boolean;
}

function parseArgs(args: readonly string[]): Options {
  const value = (flag: string): string | null => {
    const at = args.indexOf(flag);
    return at === -1 ? null : (args[at + 1] ?? null);
  };
  const players = Number(value('--players') ?? 4);
  const seed = Number(value('--seed') ?? Date.now() % 2 ** 31);
  return {
    players: Number.isInteger(players) ? players : 4,
    seed: Number.isInteger(seed) ? seed : 1,
    auto: args.includes('--auto'),
  };
}

/** Seat 0 is the human; the rest are bots. R-01: 2 to 6 seats. */
const seatNames = (count: number): readonly PlayerId[] => [
  HUMAN,
  ...Array.from({ length: count - 1 }, (_, i) => `Bot ${String(i + 1)}`),
];

// ─── rendering ────────────────────────────────────────────────────────────────

function showTable(view: PlayerView): void {
  const turn = view.phase.kind === 'bidding' ? view.phase.turnId : null;
  say();
  const palifico = view.round.palifico
    ? ` ${YELLOW}${BOLD}PALIFICO${RESET}${DIM} — ones are not wild, the face is locked${RESET}`
    : '';
  say(
    `${BOLD}Round ${String(view.round.index + 1)}${RESET}  ` +
      `${DIM}${String(view.totalDiceInPlay)} dice in play${RESET}${palifico}`,
  );
  for (const player of view.players) {
    const marker = player.id === turn ? `${CYAN}▶${RESET}` : ' ';
    const dice = player.eliminated
      ? `${DIM}out${RESET}`
      : player.id === HUMAN
        ? hand(view.you?.dice ?? [])
        : `${DIM}${'▪ '.repeat(player.diceCount).trim()}${RESET}`;
    const count = player.eliminated ? '' : `${DIM}(${String(player.diceCount)})${RESET}`;
    say(`${marker} ${player.id.padEnd(6)} ${dice} ${count}`);
  }
  if (view.round.bids.length > 0) {
    say(`${DIM}  bids:${RESET}`);
    for (const record of view.round.bids) {
      say(`${DIM}  ${record.playerId.padEnd(6)}${RESET} ${bidText(record.bid)}`);
    }
  }
}

/** R-10: the full reveal. Every hand is public at this point, and only at this point. */
function showReveal(reveal: RevealSummary): void {
  say();
  say(`${BOLD}── Reveal ──${RESET}`);
  const wildNote = reveal.wildOnes ? '' : `  ${DIM}(ones not wild)${RESET}`;
  const whose = conj(reveal.bidderId, `${reveal.bidderId}'s`, 'your');
  say(
    `${reveal.challengerId} called dudo on ${whose} bid of ` + `${bidText(reveal.bid)}${wildNote}`,
  );
  for (const [playerId, dice] of Object.entries(reveal.hands)) {
    const marked = dice.map((d) => {
      const counts = d === reveal.bid.face || (reveal.wildOnes && reveal.bid.face !== 1 && d === 1);
      return counts ? `${GREEN}${BOLD}${die(d)}${RESET}` : `${DIM}${die(d)}${RESET}`;
    });
    say(`  ${playerId.padEnd(6)} ${marked.join(' ')}`);
  }
  const verdict = reveal.bidStands
    ? `${GREEN}the bid was good${RESET}`
    : `${RED}the bid was a lie${RESET}`;
  say(
    `  ${BOLD}${String(reveal.actualCount)}${RESET} × ${die(reveal.bid.face)} against a bid of ` +
      `${String(reveal.bid.quantity)} — ${verdict}`,
  );
  say(
    `  ${RED}${reveal.loserId} ${conj(reveal.loserId, 'loses', 'lose')} a die${RESET} ` +
      `→ ${String(reveal.loserDiceCount)} left`,
  );
  if (reveal.eliminatedId !== null) {
    const out = conj(reveal.eliminatedId, 'is', 'are');
    say(`  ${RED}${BOLD}${reveal.eliminatedId} ${out} out${RESET}`);
  }
}

function showHelp(view: PlayerView): void {
  say();
  say(`${DIM}  <quantity> <face>   raise, e.g. "4 5" for four fives${RESET}`);
  if (view.round.bids.length > 0) {
    say(`${DIM}  d                   dudo — call the standing bid a lie${RESET}`);
  }
  say(`${DIM}  l                   list every legal raise${RESET}`);
  say(`${DIM}  q                   quit${RESET}`);
}

// ─── bots ─────────────────────────────────────────────────────────────────────

/**
 * A bot's move, decided from its own redacted view.
 *
 * The redaction is not ceremony: `decide` only accepts a `PlayerView`, so handing a bot anything
 * less blind than what a person sees is not expressible. Each seat keeps one profile for the whole
 * match, so the table is not three copies of the same opponent.
 */
function botAction(state: GameState, rng: () => number, profile: BotProfile): Action {
  if (state.phase.kind !== 'bidding') return { type: 'advanceRound' };
  const playerId = state.phase.turnId;
  const judgement = decide(redactFor(state, playerId), { profile, rng });
  if (judgement !== null) return judgement.action;
  // Unreachable while it is this seat's turn; falling back keeps the loop total.
  const fallback = minimumLegalBid(state);
  return fallback === null ? { type: 'dudo', playerId } : { type: 'bid', playerId, bid: fallback };
}

// ─── the loop ─────────────────────────────────────────────────────────────────

const rl = createInterface({ input: stdin, output: stdout });
const options = parseArgs(argv.slice(2));

/**
 * A queue of input lines.
 *
 * `readline/promises`' `question()` only sees lines that arrive *after* it is called, so
 * piping a script into this program drops every line but the first. Buffering the 'line'
 * events instead makes the CLI behave the same whether a human is typing or a test is
 * feeding it, and gives EOF a defined meaning: `null`, which reads as "quit".
 */
const queued: string[] = [];
let waiting: ((line: string | null) => void) | null = null;
let stdinClosed = false;
/**
 * Read through a function rather than touching the flag directly: the assignment happens
 * inside a listener, so control-flow analysis would otherwise narrow every read of the
 * variable to `false` and the linter would call the check redundant.
 */
const inputEnded = (): boolean => stdinClosed;

const deliver = (line: string | null): boolean => {
  const resolve = waiting;
  if (resolve === null) return false;
  waiting = null;
  resolve(line);
  return true;
};

rl.on('line', (line: string) => {
  if (!deliver(line)) queued.push(line);
});
rl.on('close', () => {
  stdinClosed = true;
  deliver(null);
});

function nextLine(prompt: string): Promise<string | null> {
  stdout.write(prompt);
  const buffered = queued.shift();
  if (buffered !== undefined) {
    stdout.write(`${buffered}\n`); // echo, since a pipe types nothing for us
    return Promise.resolve(buffered);
  }
  if (inputEnded()) {
    stdout.write('\n');
    return Promise.resolve(null);
  }
  return new Promise<string | null>((resolve) => {
    waiting = resolve;
  });
}
const rng = makeRng(options.seed);
const botRng = makeRng((options.seed ^ 0x9e37_79b9) >>> 0);
const now = (): number => Date.now();

const opening = createMatch(
  { matchId: `cli-${String(options.seed)}`, playerIds: seatNames(options.players) },
  { now: now(), rng },
);
if (!opening.ok) {
  say(`${RED}cannot start: ${opening.reason}${RESET}`);
  rl.close();
  exit(1);
}

say(
  `${BOLD}Liar's Dice${RESET} ${DIM}— seed ${String(options.seed)}, ` +
    `${String(options.players)} players, 5 dice each${RESET}`,
);
say(`${DIM}Ones are wild. Raise or call dudo. "?" for help.${RESET}`);

let state = opening.value.state;

/** Ask the human for an action, re-prompting until something playable comes back. */
async function humanAction(): Promise<Action | null> {
  const view = redactFor(state, HUMAN);
  const standing = view.round.bids.length > 0;
  for (;;) {
    const raw = await nextLine(`${BOLD}your move${RESET} ${DIM}(q×face, d, l, ?)${RESET} > `);
    if (raw === null) return null; // stdin ended
    const answer = raw.trim().toLowerCase();

    if (answer === 'q' || answer === 'quit') return null;
    if (answer === '?' || answer === 'h' || answer === 'help') {
      showHelp(view);
      continue;
    }
    if (answer === 'l') {
      const bids = legalBids(state);
      const shown = bids.slice(0, 18);
      const more = bids.length - shown.length;
      say(`${DIM}  ${String(bids.length)} legal raises, weakest first:${RESET}`);
      say(
        `  ${shown.map((b) => `${String(b.quantity)}×${die(b.face)}`).join('  ')}` +
          (more > 0 ? ` ${DIM}… and ${String(more)} more${RESET}` : ''),
      );
      continue;
    }
    if (answer === 'd' || answer === 'dudo') {
      if (!standing) {
        // R-06: the round's first player has nothing to challenge.
        say(`${RED}  you open the round — you must bid${RESET}`);
        continue;
      }
      return { type: 'dudo', playerId: HUMAN };
    }

    const parts = answer.split(/[\s,x×]+/).filter((p) => p !== '');
    const quantity = Number(parts[0]);
    const face = Number(parts[1]);
    if (parts.length !== 2 || !Number.isInteger(quantity) || !Number.isInteger(face)) {
      say(`${RED}  didn't follow that — try "4 5", or "?" for help${RESET}`);
      continue;
    }
    return { type: 'bid', playerId: HUMAN, bid: { quantity, face: face as Face } };
  }
}

while (state.phase.kind !== 'ended') {
  if (state.phase.kind === 'reveal') {
    const view = redactFor(state, HUMAN);
    if (view.lastReveal !== null) showReveal(view.lastReveal);
    if (!options.auto && !inputEnded()) await nextLine(`${DIM}  ↵ next round${RESET}`);
    const advanced = reduce(state, { type: 'advanceRound' }, { now: now(), rng });
    if (!advanced.ok) {
      say(`${RED}engine refused advanceRound: ${advanced.reason}${RESET}`);
      break;
    }
    state = advanced.value.state;
    continue;
  }

  const turnId = state.phase.turnId;
  const isHuman = turnId === HUMAN && !options.auto;
  if (isHuman) showTable(redactFor(state, HUMAN));

  const action = isHuman ? await humanAction() : botAction(state, botRng, profileFor(turnId));
  if (action === null) break; // the human asked to quit

  const result = reduce(state, action, { now: now(), rng });
  if (!result.ok) {
    // Illegal actions are values, so unplayable input is a message rather than a crash.
    say(`${RED}  rejected: ${result.reason}${RESET}`);
    if (result.reason === 'BID_TOO_LOW') {
      const least = minimumLegalBid(state);
      if (least !== null) {
        say(
          `${DIM}  the smallest legal raise is ` +
            `${String(least.quantity)}×${die(least.face)}${RESET}`,
        );
      }
    }
    if (result.reason === 'BID_EXCEEDS_DICE_IN_PLAY') {
      say(`${DIM}  only ${String(totalDiceInPlay(state))} dice are in play${RESET}`);
    }
    continue;
  }

  for (const event of result.value.events) {
    if (event.type === 'bidMade' && (options.auto || event.playerId !== HUMAN)) {
      const bids = conj(event.playerId, 'bids', 'bid');
      say(`  ${event.playerId} ${bids} ${bidText(event.bid)}`);
    }
    if (event.type === 'dudoCalled') {
      const calls = conj(event.playerId, 'calls', 'call');
      say(`  ${BOLD}${event.playerId} ${calls} dudo!${RESET}`);
    }
    if (event.type === 'palificoArmed') {
      const is = conj(event.playerId, 'is', 'are');
      say(`  ${YELLOW}${event.playerId} ${is} down to one die — next round is palifico${RESET}`);
    }
  }
  state = result.value.state;
}

if (state.phase.kind === 'ended') {
  const { winnerId } = state.phase;
  say();
  say(
    winnerId === HUMAN
      ? `${GREEN}${BOLD}You win.${RESET}`
      : `${BOLD}${winnerId} wins.${RESET} ${DIM}Better luck next time.${RESET}`,
  );
  say(
    `${DIM}${String(state.round.index + 1)} rounds, ${String(state.seq)} actions, ` +
      `seed ${String(options.seed)}${RESET}`,
  );
} else {
  say(`${DIM}bye${RESET}`);
}

rl.close();
