import { Schema } from "effect";

export class AutomationServiceError extends Schema.TaggedErrorClass<AutomationServiceError>()(
  "AutomationServiceError",
  {
    message: Schema.String,
    code: Schema.optional(Schema.Literal("AUTOMATION_CREATE_REJECTED")),
    cause: Schema.optional(Schema.Defect),
  },
) {}
