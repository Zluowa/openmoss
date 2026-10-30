/** Repository contract for the single durable sidebar placement authority. */
import {
  IsoDateTime,
  OrchestrationSidebarOrderItem,
  SidebarOrderMigrationState,
  SidebarOrderRevision,
  SidebarOrderDestination,
  SidebarSectionId,
  ThreadId,
  NonNegativeInt,
} from "@synara/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionSidebarOrderState = Schema.Struct({
  revision: SidebarOrderRevision,
  migrationState: SidebarOrderMigrationState,
  updatedAt: IsoDateTime,
});
export type ProjectionSidebarOrderState = typeof ProjectionSidebarOrderState.Type;

export const ProjectionSidebarArchivePlacement = Schema.Struct({
  threadId: ThreadId,
  destination: SidebarOrderDestination,
  sectionId: Schema.NullOr(SidebarSectionId),
  sectionCreatedAt: Schema.NullOr(IsoDateTime),
  sortOrder: NonNegativeInt,
  archivedByCommandId: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type ProjectionSidebarArchivePlacement = typeof ProjectionSidebarArchivePlacement.Type;

export const ReplaceProjectionSidebarOrderInput = Schema.Struct({
  revision: SidebarOrderRevision,
  migrationState: SidebarOrderMigrationState,
  updatedAt: IsoDateTime,
  items: Schema.Array(OrchestrationSidebarOrderItem),
});
export type ReplaceProjectionSidebarOrderInput = typeof ReplaceProjectionSidebarOrderInput.Type;

export const CompareAndSwapProjectionSidebarOrderInput = Schema.Struct({
  expectedRevision: SidebarOrderRevision,
  nextRevision: SidebarOrderRevision,
  migrationState: SidebarOrderMigrationState,
  updatedAt: IsoDateTime,
  items: Schema.Array(OrchestrationSidebarOrderItem),
});
export type CompareAndSwapProjectionSidebarOrderInput =
  typeof CompareAndSwapProjectionSidebarOrderInput.Type;

export const UpsertProjectionSidebarArchivePlacementInput = ProjectionSidebarArchivePlacement;
export type UpsertProjectionSidebarArchivePlacementInput =
  typeof UpsertProjectionSidebarArchivePlacementInput.Type;

export interface ProjectionSidebarOrderRepositoryShape {
  readonly getState: () => Effect.Effect<ProjectionSidebarOrderState, ProjectionRepositoryError>;
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<OrchestrationSidebarOrderItem>,
    ProjectionRepositoryError
  >;
  /** Replace the complete relation and state in the ambient transaction. */
  readonly replaceAll: (
    input: ReplaceProjectionSidebarOrderInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  /** Update only when the state still carries the expected revision. */
  readonly compareAndSwap: (
    input: CompareAndSwapProjectionSidebarOrderInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly upsertItem: (
    item: OrchestrationSidebarOrderItem,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteItem: (input: {
    readonly itemKey: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getArchivePlacement: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<Option.Option<ProjectionSidebarArchivePlacement>, ProjectionRepositoryError>;
  readonly upsertArchivePlacement: (
    placement: UpsertProjectionSidebarArchivePlacementInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteArchivePlacement: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionSidebarOrderRepository extends ServiceMap.Service<
  ProjectionSidebarOrderRepository,
  ProjectionSidebarOrderRepositoryShape
>()("moss/persistence/Services/ProjectionSidebarOrder/ProjectionSidebarOrderRepository") {}
