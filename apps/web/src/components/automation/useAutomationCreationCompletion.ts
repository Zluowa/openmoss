import type { AutomationDefinition } from "@synara/contracts";
import { useEffect, useRef, useState } from "react";

type AutomationCompletion = {
  readonly definition: AutomationDefinition;
  readonly finish: (definition: AutomationDefinition) => void | Promise<void>;
};

/** Keeps a saved automation's identity when a contextual attachment needs a retry. */
export function useAutomationCreationCompletion(onComplete: () => void) {
  const [saved, setSaved] = useState<AutomationDefinition | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef<AutomationCompletion | null>(null);
  const finishingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const finish = async (pending: AutomationCompletion) => {
    if (finishingRef.current) return;
    finishingRef.current = true;
    setFinishing(true);
    setError(null);
    const performCompletion = async () => {
      await pending.finish(pending.definition);
      pendingRef.current = null;
      if (mountedRef.current) {
        setSaved(null);
        onComplete();
      }
    };
    return performCompletion()
      .catch((cause: unknown) => {
        if (mountedRef.current) {
          setError(cause instanceof Error ? cause.message : "Could not finish automation setup.");
        }
      })
      .finally(() => {
        finishingRef.current = false;
        if (mountedRef.current) setFinishing(false);
      });
  };

  return {
    saved,
    finishing,
    error,
    complete: (
      definition: AutomationDefinition,
      complete: AutomationCompletion["finish"],
    ): Promise<void> => {
      // Once creation succeeds, callers must finish this ID before starting another one.
      if (pendingRef.current !== null) return finish(pendingRef.current);
      const pending = { definition, finish: complete };
      pendingRef.current = pending;
      setSaved(definition);
      return finish(pending);
    },
    retry: (): Promise<void> =>
      pendingRef.current === null ? Promise.resolve() : finish(pendingRef.current),
  };
}
