import { Schema } from "effect";

export class LibraryServiceError extends Schema.TaggedErrorClass<LibraryServiceError>()(
  "LibraryServiceError",
  {
    message: Schema.String,
    code: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const LIBRARY_SERVICE_ERROR_CODE = "LIBRARY_ERROR";
