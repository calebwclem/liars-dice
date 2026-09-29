/**
 * Dice, drawn rather than typed.
 *
 * Same decision as the iOS client: the Unicode die glyphs (⚀–⚅) are missing from enough fonts
 * that they render as a placeholder box, which is how "Revealed: 4 × ▫" once reached a
 * screenshot. Nine grid cells and a pip in the right ones works everywhere.
 */
import type { Face } from '@liars-dice/protocol';

/** Which of the nine cells carry a pip, on the usual layout. */
const LAYOUT: Record<Face, readonly number[]> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

export function Die({
  face,
  size = 40,
  counting = false,
  hidden = false,
}: {
  face?: Face;
  size?: number;
  counting?: boolean;
  hidden?: boolean;
}) {
  // Padding and gap in pixels derived from `size`, never percentages. A percentage padding
  // resolves against the *containing block's* width, not the element's own — so a 44px die in a
  // 490px row was given 59px of padding a side and ballooned to 117px, taking the pips' grid
  // down to zero in the process. That is the bug this comment exists to stop coming back.
  const style = {
    width: size,
    height: size,
    padding: Math.round(size * 0.13),
    gap: Math.max(1, Math.round(size * 0.05)),
  };
  const label = hidden ? 'a hidden die' : face === undefined ? 'a die' : `a ${String(face)}`;
  if (hidden || face === undefined) {
    return <span className="die hidden" style={style} role="img" aria-label={label} />;
  }
  // `data-face` is for tests: happy-dom does no layout, so asserting on pip count is the only
  // way to check a die is drawn correctly, and that needs the face to be findable.

  const pips = LAYOUT[face];
  return (
    <span
      className={`die${counting ? ' counting' : ''}`}
      style={style}
      role="img"
      data-face={face}
      aria-label={counting ? `${label}, counting` : label}
    >
      {Array.from({ length: 9 }, (_, cell) => (
        <span key={cell}>{pips.includes(cell) ? <span className="pip" /> : null}</span>
      ))}
    </span>
  );
}

/** A row of dice, for a hand. */
export function Hand({
  dice,
  size = 40,
  countingFace,
}: {
  dice: readonly Face[];
  size?: number;
  countingFace?: Face;
}) {
  return (
    <span className="row hand" style={{ gap: size * 0.18 }}>
      {dice.map((face, index) => (
        <Die key={index} face={face} size={size} counting={counts(face, countingFace)} />
      ))}
    </span>
  );
}

/** R-07: a one counts toward any face, but a bid *on* ones counts only ones. */
export function counts(face: Face, countingFace: Face | undefined): boolean {
  if (countingFace === undefined) return false;
  if (face === countingFace) return true;
  return countingFace !== 1 && face === 1;
}

const PLURAL: Record<Face, string> = {
  1: 'ones',
  2: 'twos',
  3: 'threes',
  4: 'fours',
  5: 'fives',
  6: 'sixes',
};

/**
 * Spelled out rather than derived.
 *
 * Dropping the final letter of the plural works for five of the six faces and turns "sixes" into
 * "sixe", which is how "1 sixe" reached a screenshot. English is the one thing in this repo with
 * no rules engine behind it; a table is cheaper than a clever rule that is wrong once in six.
 */
const SINGULAR: Record<Face, string> = {
  1: 'one',
  2: 'two',
  3: 'three',
  4: 'four',
  5: 'five',
  6: 'six',
};

/** "1 four", "4 fours". */
export function spoken(quantity: number, face: Face): string {
  return `${String(quantity)} ${quantity === 1 ? SINGULAR[face] : PLURAL[face]}`;
}

/**
 * "Dana bids" / "You bid".
 *
 * Third-person copy meeting a second-person name is what produces "You opens" and "You loses a
 * die". Every sentence in the feed that has a subject goes through here, so the verb is chosen
 * at the same moment as the name rather than assumed.
 */
export function subject(
  playerId: string,
  me: string | null,
  third: string,
  second: string,
): string {
  return `${shortName(playerId, me)} ${playerId === me ? second : third}`;
}

/** "Dana's" / "your". */
export function possessive(playerId: string, me: string | null): string {
  return playerId === me ? 'your' : `${shortName(playerId, me)}'s`;
}

/** A guest id is a UUID; nobody wants to read one. */
export function shortName(playerId: string, me: string | null): string {
  if (playerId === me) return 'You';
  if (playerId.startsWith('bot_')) return `Bot ${playerId.slice(-4)}`;
  const trimmed = playerId.startsWith('g_') ? playerId.slice(2) : playerId;
  return `Player ${trimmed.slice(0, 4)}`;
}
