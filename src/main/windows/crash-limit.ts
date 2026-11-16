/**
 * A window whose renderer died is brought back at once — but one that keeps dying (a file that crashes it on every
 * load) not forever: at most `max` times within `windowMs`, then it is left to the operator, the reason in crash.log
 * (2026-11-15 audit, A1). One per window kind: the projector, the stage screen, the NDI® copy.
 */
export function crashLimit(max = 3, windowMs = 60_000): () => boolean {
  const crashes: number[] = [];
  return () => {
    const now = Date.now();
    while (crashes.length > 0 && (crashes[0] ?? now) < now - windowMs) crashes.shift();
    crashes.push(now);
    return crashes.length <= max;
  };
}
