"use client";

import { useSyncExternalStore } from "react";

// prefers-reduced-motion as a hook: charts pass isAnimationActive={!reduced}
// (spec 8). Server snapshot is "reduced" so the first paint never animates.
const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(cb: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => true,
  );
}
