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
  const style = { width: size, height: size };
  const label = hidden ? 'a hidden die' : face === undefined ? 'a die' : `a ${String(face)}`;
  if (hidden || face === undefined) {
    return <span className="die hidden" style={style} role="img" aria-label={label} />;
  }
  const pips = LAYOUT[face];
  return (
    <span
      className={`die${counting ? ' counting' : ''}`}
      style={style}
      role="img"
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
    <span className="row" style={{ gap: size * 0.18 }}>
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

const SPOKEN: Record<Face, string> = {
  1: 'ones',
  2: 'twos',
  3: 'threes',
  4: 'fours',
  5: 'fives',
  6: 'sixes',
};

/** "1 four", "4 fours". */
export function spoken(quantity: number, face: Face): string {
  const word = quantity === 1 ? SPOKEN[face].slice(0, -1) : SPOKEN[face];
  return `${String(quantity)} ${word}`;
}

/** A guest id is a UUID; nobody wants to read one. */
export function shortName(playerId: string, me: string | null): string {
  if (playerId === me) return 'You';
  if (playerId.startsWith('bot_')) return `Bot ${playerId.slice(-4)}`;
  const trimmed = playerId.startsWith('g_') ? playerId.slice(2) : playerId;
  return `Player ${trimmed.slice(0, 4)}`;
}
