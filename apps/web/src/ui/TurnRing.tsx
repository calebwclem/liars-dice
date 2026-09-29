/**
 * R-16's thirty seconds, drawn.
 *
 * The server sends how long is left at the moment it *builds* the snapshot, never an absolute
 * timestamp — a browser with a skewed clock would otherwise draw the wrong ring. The session
 * turns that into a deadline on this machine's clock the instant the message lands, and this
 * counts down from it.
 *
 * Nothing here enforces anything. The server owns the deadline and will play a minimum raise if
 * it passes (R-17); this only makes the fact visible, which is the whole reason it exists — a
 * turn that gets played for you with no warning feels like a bug.
 */
import { useEffect, useState } from 'react';

/** Seconds remaining below which the ring turns from brass to alarm. */
const URGENT_SECONDS = 10;

export function TurnRing({
  deadline,
  total,
  size = 40,
}: {
  /** When the turn runs out, on this machine's clock. */
  deadline: number;
  /** The full turn length in ms, so the ring knows what a whole circle means. */
  total: number;
  size?: number;
}) {
  const now = useNow();
  const remaining = Math.max(0, deadline - now);
  const fraction = total > 0 ? Math.min(1, remaining / total) : 0;
  const seconds = Math.ceil(remaining / 1000);
  const urgent = remaining <= URGENT_SECONDS * 1000;

  const radius = 42;
  const circumference = 2 * Math.PI * radius;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="timer"
      aria-label={`${String(seconds)} seconds left this turn`}
    >
      <circle
        cx="50"
        cy="50"
        r={radius}
        fill="none"
        stroke="rgba(255,255,255,0.16)"
        strokeWidth="11"
      />
      <circle
        cx="50"
        cy="50"
        r={radius}
        fill="none"
        stroke={urgent ? 'var(--alarm)' : 'var(--brass)'}
        strokeWidth="11"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - fraction)}
        transform="rotate(-90 50 50)"
      />
      <text
        x="50"
        y="50"
        textAnchor="middle"
        dominantBaseline="central"
        fill={urgent ? 'var(--alarm)' : 'var(--ink)'}
        fontSize="42"
        fontWeight="600"
      >
        {seconds}
      </text>
    </svg>
  );
}

/**
 * The current time, re-read often enough to animate.
 *
 * A frame at a time normally; once a second when the viewer has asked for reduced motion, since
 * a sweeping ring is exactly the kind of continuous movement that setting is about. The number
 * still counts down either way — the information is never the thing that gets removed.
 */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reduced) {
      const id = window.setInterval(() => {
        setNow(Date.now());
      }, 1_000);
      return () => {
        window.clearInterval(id);
      };
    }

    let frame = 0;
    const tick = () => {
      setNow(Date.now());
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, []);

  return now;
}
