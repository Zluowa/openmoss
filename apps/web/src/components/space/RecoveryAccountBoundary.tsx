import { useQueryClient } from "@tanstack/react-query";
import { Fragment, useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  readMossImagesAccountBoundary,
  useMossImagesAccountBoundary,
} from "~/lib/mossImagesAccountBoundary";

/** Synchronous cache notifications fence an A → B → A transition even if React
 * batches both updates into one render. Recovery titles never enter query cache. */
export function RecoveryAccountBoundary({
  children,
}: {
  children: (current: () => boolean) => ReactNode;
}) {
  const client = useQueryClient();
  const account = useMossImagesAccountBoundary();
  const serial = useRef(0);
  const [generation, setGeneration] = useState(0);
  useLayoutEffect(() => {
    let prior = readMossImagesAccountBoundary(client);
    const changed = () => {
      const next = readMossImagesAccountBoundary(client);
      if (next === prior) return;
      prior = next;
      setGeneration(++serial.current);
    };
    const offQueries = client.getQueryCache().subscribe(changed);
    const offMutations = client.getMutationCache().subscribe(changed);
    return () => {
      offQueries();
      offMutations();
    };
  }, [client]);
  const current = useCallback(
    () => serial.current === generation && account.isCurrent(),
    [account.isCurrent, generation],
  );
  return account.transitioning ? null : (
    <Fragment key={`${account.key}:${generation}`}>{children(current)}</Fragment>
  );
}
