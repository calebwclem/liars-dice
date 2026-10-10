/**
 * Writing a finished match down.
 *
 * PLAN.md's cheap-wins list calls deterministic replay "the single best debugging tool you will
 * have": with a pure engine, a recorded match can be put back through `reduce` and watched. The
 * room has always kept its action list, but only in memory, so a bug reported an hour after the
 * fact had nothing behind it but log lines.
 *
 * **What is safe to write, and why.** The transcript carries the actions and the events the room
 * actually broadcast — nothing else. CLAUDE.md forbids serialising a hidden die outside a reveal,
 * and building the file out of published events is what makes that true by construction rather
 * than by care: the engine's own invariant is that no event carries a die face except
 * `diceRevealed`, which fires only after R-10. A round that never reached a reveal contributes no
 * dice to the file, which is also exactly why an abandoned match is not fully replayable.
 *
 * **What it cannot do.** R-20 rolls dice with a CSPRNG, so the action list alone does not
 * reproduce a match — see the 2026-09-14 entry in DECISIONS.md. The rolls come back from the
 * reveal events instead, which covers every round that was played to a challenge (under R-10,
 * that is every completed round) and no round that was interrupted. Exact replay of an
 * interrupted round waits for R-21's per-match seed in v1.1.
 *
 * Node builtins only, and one file per match, written once when the match is over. There is no
 * database here until Phase 6 and this is deliberately not the start of one.
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Action, GameState, PlayerId } from '@liars-dice/engine';
import type { ProtocolEvent } from '@liars-dice/protocol';
import type { Logger } from './logger.ts';

/** One finished match, as much of it as was ever public. */
export interface MatchTranscript {
  readonly matchId: string;
  /** `ended` means somebody won; `abandoned` means R-19 fired. */
  readonly status: 'ended' | 'abandoned';
  readonly startedAt: number;
  readonly endedAt: number;
  readonly winnerId: PlayerId | null;
  readonly seats: readonly { readonly playerId: PlayerId; readonly kind: 'human' | 'bot' }[];
  readonly config: GameState['config'];
  /** Every action the engine accepted, in order. Replay feeds these back to `reduce`. */
  readonly actions: readonly Action[];
  /** Every transition the room broadcast, in order. The dice live in the reveals here. */
  readonly transitions: readonly {
    readonly seq: number;
    readonly events: readonly ProtocolEvent[];
  }[];
}

export interface MatchArchive {
  /**
   * Record a finished match. Never throws and never blocks the room: a server that cannot
   * write its debugging archive is still a perfectly good server, and a match that has just
   * ended is not the moment to find out the disk is full.
   */
  record(transcript: MatchTranscript): void;
}

/** An archive that keeps nothing. What you get when `MATCH_ARCHIVE_DIR` is unset. */
export function noArchive(): MatchArchive {
  return { record: () => undefined };
}

/**
 * One JSON file per match under `dir`.
 *
 * Written to a temporary name and renamed, so a reader never sees half a transcript — `rename`
 * within a directory is atomic, which a plain `writeFile` to the final path is not.
 */
export function fileArchive(dir: string, log: Logger): MatchArchive {
  const base = resolve(dir);
  return {
    record(transcript) {
      void (async () => {
        const target = join(base, `${transcript.matchId}.json`);
        try {
          await mkdir(base, { recursive: true });
          const temporary = `${target}.${String(process.pid)}.tmp`;
          await writeFile(temporary, `${JSON.stringify(transcript, null, 2)}\n`, 'utf8');
          await rename(temporary, target);
          log.info('match.archived', {
            matchId: transcript.matchId,
            status: transcript.status,
            actions: transcript.actions.length,
            path: target,
          });
        } catch (error) {
          log.warn('match.archiveFailed', {
            matchId: transcript.matchId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    },
  };
}
