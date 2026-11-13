import { useSyncExternalStore } from "react";

/**
 * Tiny global store (no dependencies). Components subscribe with a selector and only
 * re-render when the selected value changes (Object.is). Keep selectors returning
 * existing references, not freshly built objects/arrays.
 */
export function createStore<T extends object>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();
  const get = () => state;
  const set = (patch: Partial<T> | ((s: T) => Partial<T>)) => {
    const next = typeof patch === "function" ? patch(state) : patch;
    state = { ...state, ...next };
    for (const l of listeners) l();
  };
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  };
  function useStore<U>(selector: (s: T) => U): U {
    return useSyncExternalStore(subscribe, () => selector(state));
  }
  return { get, set, subscribe, useStore };
}
