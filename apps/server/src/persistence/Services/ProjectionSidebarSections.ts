/**
 * Durable projection rows for custom thread-only sidebar sections.
 *
 * Membership is keyed by a namespaced item key ("thread:<id>"). The
 * namespace keeps the table forward-compatible with project sections without
 * making the current thread-only UI pretend those rows exist.
 */
import {
  IsoDateTime,
  NonNegativeInt,
  SidebarSectionId,
  SidebarSectionItemKey,
  SidebarSectionItemType,
  SidebarSectionName,
} from "@synara/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionSidebarSectionItem = Schema.Struct({
  sectionId: SidebarSectionId,
  itemKey: SidebarSectionItemKey,
  itemType: SidebarSectionItemType,
  sortOrder: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionSidebarSectionItem = typeof ProjectionSidebarSectionItem.Type;

export const ProjectionSidebarSection = Schema.Struct({
  sectionId: SidebarSectionId,
  name: SidebarSectionName,
  sortOrder: NonNegativeInt,
  isCollapsed: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
  items: Schema.Array(ProjectionSidebarSectionItem),
});
export type ProjectionSidebarSection = typeof ProjectionSidebarSection.Type;

export const GetProjectionSidebarSectionInput = Schema.Struct({
  sectionId: SidebarSectionId,
});
export type GetProjectionSidebarSectionInput = typeof GetProjectionSidebarSectionInput.Type;

export const UpsertProjectionSidebarSectionItemInput = ProjectionSidebarSectionItem;
export type UpsertProjectionSidebarSectionItemInput =
  typeof UpsertProjectionSidebarSectionItemInput.Type;

export const DeleteProjectionSidebarSectionItemInput = Schema.Struct({
  itemKey: SidebarSectionItemKey,
});
export type DeleteProjectionSidebarSectionItemInput =
  typeof DeleteProjectionSidebarSectionItemInput.Type;

export const ReplaceProjectionSidebarSectionItemsInput = Schema.Struct({
  sectionId: SidebarSectionId,
  items: Schema.Array(ProjectionSidebarSectionItem),
});
export type ReplaceProjectionSidebarSectionItemsInput =
  typeof ReplaceProjectionSidebarSectionItemsInput.Type;

export interface ProjectionSidebarSectionRepositoryShape {
  readonly upsertSection: (
    section: ProjectionSidebarSection,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetProjectionSidebarSectionInput,
  ) => Effect.Effect<Option.Option<ProjectionSidebarSection>, ProjectionRepositoryError>;
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<ProjectionSidebarSection>,
    ProjectionRepositoryError
  >;
  readonly upsertItem: (
    item: UpsertProjectionSidebarSectionItemInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteItem: (
    input: DeleteProjectionSidebarSectionItemInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  /** Replace one section's complete ordered item set in the ambient transaction. */
  readonly replaceItems: (
    input: ReplaceProjectionSidebarSectionItemsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteSection: (
    input: GetProjectionSidebarSectionInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionSidebarSectionRepository extends ServiceMap.Service<
  ProjectionSidebarSectionRepository,
  ProjectionSidebarSectionRepositoryShape
>()("moss/persistence/Services/ProjectionSidebarSections/ProjectionSidebarSectionRepository") {}
