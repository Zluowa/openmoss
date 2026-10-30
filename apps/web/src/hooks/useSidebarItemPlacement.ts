// FILE: useSidebarItemPlacement.ts
// Purpose: Revision-guarded optimistic placement for mixed sidebar items.

import type { OrchestrationSidebarOrderItem, SidebarSectionItemKey } from "@synara/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { placeSidebarItemOrder, type SidebarItemOrderPlacementInput } from "../sidebarThreadOrder";
import type { SidebarItemPlacementRequest } from "../components/SidebarItemPlacementDnd";

export interface SidebarItemPlacementDispatchResult {
  readonly sequence?: number;
  readonly sidebarOrderRevision?: number | undefined;
}

export interface SidebarItemPlacementUndoDescriptor {
  readonly itemKey: SidebarSectionItemKey;
  readonly itemType: "thread" | "project";
  readonly destination: "pinned" | "default" | "custom";
  readonly sectionId: string | null;
  readonly sectionCreatedAt: string | null;
  readonly beforeItemKey: SidebarSectionItemKey | null;
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

export function useSidebarItemPlacement(input: {
  readonly orderItems?: readonly OrchestrationSidebarOrderItem[] | undefined;
  readonly orderRevision: number;
  readonly migrationState: "ready" | "legacy_import_required";
  readonly dispatchPlacement: (
    request: SidebarItemPlacementRequest & { readonly expectedSidebarOrderRevision: number },
  ) => Promise<SidebarItemPlacementDispatchResult>;
  readonly rehydrate: () => void | Promise<void>;
  readonly onRejected?: (error: unknown) => void;
}) {
  const { dispatchPlacement, migrationState, onRejected, orderItems, orderRevision, rehydrate } =
    input;
  const [optimisticItems, setOptimisticItems] = useState<OrchestrationSidebarOrderItem[] | null>(
    null,
  );
  const [inFlight, setInFlight] = useState(false);
  const [undoDescriptor, setUndoDescriptor] = useState<SidebarItemPlacementUndoDescriptor | null>(
    null,
  );
  const [pendingUndoDescriptor, setPendingUndoDescriptor] =
    useState<SidebarItemPlacementUndoDescriptor | null>(null);
  const authoritativeRevisionRef = useRef(orderRevision);
  const inFlightRef = useRef(false);
  const pendingResultRevisionRef = useRef<number | null>(null);
  const pendingUndoDescriptorRef = useRef<SidebarItemPlacementUndoDescriptor | null>(null);

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
        pendingResultRevisionRef.current = null;
        pendingUndoDescriptorRef.current = null;
        setOptimisticItems(null);
        setUndoDescriptor(null);
        setPendingUndoDescriptor(null);
        void Promise.resolve(rehydrate()).catch(() => undefined);
      }
    } else if (pendingRevision !== null && orderRevision >= pendingRevision) {
      // Undo has no inverse descriptor to promote. It still uses the same
      // revision fence, so release the placement lock once that accepted
      // revision has reached the authoritative shell.
      pendingResultRevisionRef.current = null;
      if (orderRevision > pendingRevision) {
        void Promise.resolve(rehydrate()).catch(() => undefined);
      }
    }
    if (undoDescriptor !== null && orderRevision > undoDescriptor.resultingRevision) {
      setUndoDescriptor(null);
    }
  }, [orderRevision, pendingUndoDescriptor, rehydrate, undoDescriptor]);

  const place = useCallback(
    async (request: SidebarItemPlacementRequest): Promise<boolean> => {
      if (
        orderItems === undefined ||
        migrationState !== "ready" ||
        inFlight ||
        inFlightRef.current ||
        pendingResultRevisionRef.current !== null ||
        request.itemKey === request.beforeItemKey
      ) {
        return false;
      }
      const computed = placeSidebarItemOrder(orderItems, {
        ...request,
        now: new Date().toISOString(),
      } satisfies SidebarItemOrderPlacementInput);
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
        const nextUndoDescriptor: SidebarItemPlacementUndoDescriptor = {
          itemKey: request.itemKey,
          itemType: request.itemType,
          destination: computed.previous?.destination ?? "default",
          sectionId: computed.previous?.sectionId ?? null,
          sectionCreatedAt: computed.previous?.sectionCreatedAt ?? null,
          beforeItemKey: computed.previousSuccessorItemKey,
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
        if (!isUnknownPlacementOutcome(error)) onRejected?.(error);
        try {
          await rehydrate();
        } catch {
          // A missing snapshot cannot be promoted to a success or failure claim.
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
          // Keep a stale inverse unavailable until a later authoritative hydration.
        }
      }
      return false;
    }
    inFlightRef.current = true;
    setInFlight(true);
    try {
      const result = await dispatchPlacement({
        itemKey: descriptor.itemKey,
        itemType: descriptor.itemType,
        destination: descriptor.destination,
        sectionId: descriptor.sectionId,
        sectionCreatedAt: descriptor.sectionCreatedAt,
        beforeItemKey: descriptor.beforeItemKey,
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
      if (!isUnknownPlacementOutcome(error)) onRejected?.(error);
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

  return {
    displayItems: useMemo(() => optimisticItems ?? orderItems, [optimisticItems, orderItems]),
    inFlight,
    optimistic: optimisticItems !== null,
    place,
    undo,
    undoDescriptor,
  } as const;
}
