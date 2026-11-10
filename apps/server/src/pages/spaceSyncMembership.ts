type Listener = (scope: string | null, space: string) => void;
const listeners = new WeakMap<object, Set<Listener>>();
export function onSpaceMembershipChange(db: object, listener: Listener) {
  const set = listeners.get(db) ?? new Set<Listener>();
  listeners.set(db, set);
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}
export function changingSpaceMembership(db: object, scope: string | null, space: string | null) {
  if (space !== null) for (const fn of listeners.get(db) ?? []) fn(scope, space);
}
