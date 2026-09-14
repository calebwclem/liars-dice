/**
 * Time, injected.
 *
 * R-16 and R-18 are timer rules, and a test that waits 45 real seconds to check one is a
 * test nobody runs. Every timer in the server goes through this interface, so the tests
 * drive a fake clock and 45 seconds costs nothing — the same reasoning that made the
 * engine take `ctx.now` instead of reading one.
 */
export interface TimerHandle {
  readonly id: number;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle | null): void;
}

export function systemClock(): Clock {
  const timers = new Map<number, NodeJS.Timeout>();
  let nextId = 1;
  return {
    now: () => Date.now(),
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          fn();
        }, ms),
      );
      return { id };
    },
    clearTimeout(handle) {
      if (handle === null) return;
      const timer = timers.get(handle.id);
      if (timer !== undefined) {
        clearTimeout(timer);
        timers.delete(handle.id);
      }
    },
  };
}
