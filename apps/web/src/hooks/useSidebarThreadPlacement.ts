// FILE: useSidebarThreadPlacement.ts
// Purpose: Owns the optimistic, revision-guarded sidebar thread placement flow.

import type { OrchestrationSidebarOrderItem, ThreadId } from "@synara/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  placeSidebarThreadOrder,
  type SidebarThreadOrderPlacementInput,
} from "../sidebarThreadOrder";
import type { SidebarThreadPlacementRequest } from "../components/SidebarThreadPlacementDnd";

export interface SidebarThreadPlacementDispatchResult {
  readonly sequence?: number;
  readonly sidebarOrderRevision?: number | undefined;
}

export interface SidebarThreadPlacementUndoDescriptor {
  readonly threadId: ThreadId;
  readonly destination: "pinned" | "default" | "custom";
  readonly sectionId: string | null;
  readonly sectionCreatedAt: string | null;
  readonly beforeThreadId: ThreadId | null;
  readonly resultingRevision: number;
}

function isUnknownPlacementOutcome(error: unknown): boolean {
  const value = error as { readonly code?: unknown; readonly message?: unknown } | null;
  const text = [value?.code, value?.message]
    .filter((entry): entry is string => typeof entry === "string")
    .join(" ")
    .toLowerCase();
  return ["timeout", "timed out", "disconnect", "network", "unknown outcome"].some((marker) =>
    text.includes(marker),
  );
}

export function useSidebarThreadPlacement(input: {
  readonly orderItems?: readonly OrchestrationSidebarOrderItem[] | undefined;
  readonly orderRevision: number;
  readonly migrationState: "ready" | "legacy_import_required";
  readonly dispatchPlacement: (
    request: SidebarThreadPlacementRequest & { readonly expectedSidebarOrderRevision: number },
  ) => Promise<SidebarThreadPlacementDispatchResult>;
  readonly rehydrate: () => void | Promise<void>;
  readonly onRejected?: (error: unknown) => void;
}) {
  const { dispatchPlacement, migrationState, onRejected, orderItems, orderRevision, rehydrate } =
    input;
  const [optimisticItems, setOptimisticItems] = useState<OrchestrationSidebarOrderItem[] | null>(
    null,
  );
  const [inFlight, setInFlight] = useState(false);
  const [undoDescriptor, setUndoDescriptor] = useState<SidebarThreadPlacementUndoDescriptor | null>(
    null,
  );
  const [pendingUndoDescriptor, setPendingUndoDescriptor] =
    useState<SidebarThreadPlacementUndoDescriptor | null>(null);
  const authoritativeRevisionRef = useRef(orderRevision);
  const inFlightRef = useRef(false);
  const pendingResultRevisionRef = useRef<number | null>(null);
  const pendingUndoDescriptorRef = useRef<SidebarThreadPlacementUndoDescriptor | null>(null);

  useEffect(() => {
    authoritativeRevisionRef.current = orderRevision;
    const pendingRevision = pendingResultRevisionRef.current;
    const pendingDescriptor = pendingUndoDescriptorRef.current ?? pendingUndoDescriptor;
    if (pendingRevision !== null && pendingDescriptor !== null) {
      if (orderRevision === pendingRevision) {
        pendingResultRevisionRef.current = null;
        pendingUndoDescriptorRef.current = null;
        setOptimisticItems(null);
        setUndoDescriptor(pendingDescriptor);
        setPendingUndoDescriptor(null);
      } else if (orderRevision > pendingRevision) {
        // A later revision arrived before the accepted placement was observed.
        // Do not expose an inverse for an event that may have been skipped.
        pendingResultRevisionRef.current = null;
        pendingUndoDescriptorRef.current = null;
        setOptimisticItems(null);
        setUndoDescriptor(null);
        setPendingUndoDescriptor(null);
        void Promise.resolve(rehydrate()).catch(() => {
          // Keep the optimistic overlay discarded until a later hydration.
        });
      }
    } else if (pendingRevision !== null && orderRevision >= pendingRevision) {
      // Undo has no inverse descriptor to promote. Release its revision fence
      // once the accepted undo revision reaches the authoritative shell.
      pendingResultRevisionRef.current = null;
      if (orderRevision > pendingRevision) {
        void Promise.resolve(rehydrate()).catch(() => undefined);
      }
    }
    if (undoDescriptor !== null && orderRevision > undoDescriptor.resultingRevision) {
      // A different ordered mutation won the race; the inverse is stale.
      setUndoDescriptor(null);
    }
  }, [orderRevision, pendingUndoDescriptor, rehydrate, undoDescriptor]);

  const place = useCallback(
    async (request: SidebarThreadPlacementRequest): Promise<boolean> => {
      if (
        orderItems === undefined ||
        migrationState !== "ready" ||
        inFlight ||
        inFlightRef.current ||
        pendingResultRevisionRef.current !== null ||
        request.threadId === request.beforeThreadId
      ) {
        return false;
      }
      const now = new Date().toISOString();
      const computed = placeSidebarThreadOrder(orderItems, {
        ...request,
        now,
      } satisfies SidebarThreadOrderPlacementInput);
      if (computed === null || !computed.changed) return false;
      const expectedRevision = authoritativeRevisionRef.current;
      setOptimisticItems(computed.items);
      inFlightRef.current = true;
      setInFlight(true);
      try {
        const result = await dispatchPlacement({
          ...request,
          expectedSidebarOrderRevision: expectedRevision,
        });
        const resultingRevision = result.sidebarOrderRevision;
        if (resultingRevision === undefined || !Number.isSafeInteger(resultingRevision)) {
          throw new Error("Sidebar placement did not return an accepted revision.");
        }
        const nextUndoDescriptor: SidebarThreadPlacementUndoDescriptor = {
          threadId: request.threadId,
          destination: computed.previous?.destination ?? "default",
          sectionId: computed.previous?.sectionId ?? null,
          sectionCreatedAt: computed.previous?.sectionCreatedAt ?? null,
          beforeThreadId: computed.previousSuccessorThreadId,
          resultingRevision,
        };
        pendingResultRevisionRef.current = resultingRevision;
        pendingUndoDescriptorRef.current = nextUndoDescriptor;
        const currentRevision = authoritativeRevisionRef.current;
        if (currentRevision === resultingRevision) {
          pendingResultRevisionRef.current = null;
          pendingUndoDescriptorRef.current = null;
          setOptimisticItems(null);
          setUndoDescriptor(nextUndoDescriptor);
          setPendingUndoDescriptor(null);
        } else if (currentRevision > resultingRevision) {
          pendingResultRevisionRef.current = null;
          pendingUndoDescriptorRef.current = null;
          setOptimisticItems(null);
          setUndoDescriptor(null);
          setPendingUndoDescriptor(null);
          void Promise.resolve(rehydrate()).catch(() => undefined);
        } else {
          setPendingUndoDescriptor(nextUndoDescriptor);
        }
        return true;
      } catch (error) {
        pendingResultRevisionRef.current = null;
        pendingUndoDescriptorRef.current = null;
        setOptimisticItems(null);
        setUndoDescriptor(null);
        setPendingUndoDescriptor(null);
        if (!isUnknownPlacementOutcome(error)) {
          onRejected?.(error);
        }
        try {
          await rehydrate();
        } catch {
          // The overlay is already discarded; an unavailable snapshot cannot
          // be converted into a success or failure claim.
        }
        return false;
      } finally {
        inFlightRef.current = false;
        setInFlight(false);
      }
    },
    [dispatchPlacement, inFlight, migrationState, onRejected, orderItems, rehydrate],
  );

  const undo = useCallback(async (): Promise<boolean> => {
    const descriptor = undoDescriptor;
    if (
      descriptor === null ||
      inFlight ||
      inFlightRef.current ||
      migrationState !== "ready" ||
      orderItems === undefined ||
      authoritativeRevisionRef.current !== descriptor.resultingRevision
    ) {
      if (descriptor !== null) {
        setUndoDescriptor(null);
        try {
          await rehydrate();
        } catch {
          // A stale inverse remains unavailable until hydration succeeds.
        }
      }
      return false;
    }
    inFlightRef.current = true;
    setInFlight(true);
    try {
      const result = await dispatchPlacement({
        threadId: descriptor.threadId,
        destination: descriptor.destination,
        sectionId: descriptor.sectionId,
        sectionCreatedAt: descriptor.sectionCreatedAt,
        beforeThreadId: descriptor.beforeThreadId,
        expectedSidebarOrderRevision: descriptor.resultingRevision,
      });
      const resultingRevision = result.sidebarOrderRevision;
      if (resultingRevision === undefined || !Number.isSafeInteger(resultingRevision)) {
        throw new Error("Sidebar undo did not return an accepted revision.");
      }
      pendingResultRevisionRef.current = resultingRevision;
      pendingUndoDescriptorRef.current = null;
      setPendingUndoDescriptor(null);
      setUndoDescriptor(null);
      if (authoritativeRevisionRef.current >= resultingRevision) {
        pendingResultRevisionRef.current = null;
        if (authoritativeRevisionRef.current > resultingRevision) {
          void Promise.resolve(rehydrate()).catch(() => undefined);
        }
      }
      return true;
    } catch (error) {
      pendingResultRevisionRef.current = null;
      pendingUndoDescriptorRef.current = null;
      setOptimisticItems(null);
      setUndoDescriptor(null);
      setPendingUndoDescriptor(null);
      if (!isUnknownPlacementOutcome(error)) {
        onRejected?.(error);
      }
      try {
        await rehydrate();
      } catch {
        // Keep the inverse unavailable until a later authoritative hydration.
      }
      return false;
    } finally {
      inFlightRef.current = false;
      setInFlight(false);
    }
  }, [
    dispatchPlacement,
    inFlight,
    migrationState,
    onRejected,
    orderItems,
    rehydrate,
    undoDescriptor,
  ]);

  const displayItems = useMemo(() => optimisticItems ?? orderItems, [optimisticItems, orderItems]);

  return {
    displayItems,
    inFlight,
    optimistic: optimisticItems !== null,
    place,
    undo,
    undoDescriptor,
  } as const;
}
