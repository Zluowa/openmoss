// FILE: AcpElicitationSupport.test.ts
// Purpose: Verifies ACP form schemas and Moss answers round-trip without losing primitive types.
// Layer: Provider ACP tests
// Depends on: AcpElicitationSupport.

import { describe, expect, it } from "vitest";

import {
  elicitationQuestionsFromRequest,
  elicitationResponseFromAnswers,
} from "./AcpElicitationSupport.ts";

const request = {
  mode: "form" as const,
  sessionId: "session-1",
  message: "Choose deployment settings",
  requestedSchema: {
    type: "object" as const,
    properties: {
      environment: {
        type: "string" as const,
        title: "Environment",
        description: "Where should this deploy?",
        enum: ["Staging", "Production"],
      },
      replicas: {
        type: "integer" as const,
        title: "Replicas",
        description: "How many replicas?",
      },
      notify: {
        type: "boolean" as const,
        title: "Notify",
        description: "Send a notification?",
      },
    },
  },
};

describe("ACP elicitation mapping", () => {
  it("maps primitive form fields to Moss questions", () => {
    expect(elicitationQuestionsFromRequest(request)).toEqual([
      {
        id: "environment",
        header: "Environment",
        question: "Where should this deploy?",
        options: [
          { label: "Staging", description: "Staging" },
          { label: "Production", description: "Production" },
        ],
        multiSelect: false,
      },
      expect.objectContaining({ id: "replicas", options: [] }),
      expect.objectContaining({
        id: "notify",
        options: [
          { label: "Yes", description: "Yes" },
          { label: "No", description: "No" },
        ],
      }),
    ]);
  });

  it("coerces submitted text back to the ACP property's native type", () => {
    expect(
      elicitationResponseFromAnswers(request, {
        environment: "Production",
        replicas: "3",
        notify: "Yes",
      }),
    ).toEqual({
      action: "accept",
      content: { environment: "Production", replicas: 3, notify: true },
    });
  });

  it("keeps fields named like other-answer companions as independent questions", () => {
    const ordinaryRequest = {
      ...request,
      requestedSchema: {
        type: "object" as const,
        properties: {
          choice: { type: "string" as const, enum: ["first", "other"] },
          choice_other: { type: "string" as const },
          text: { type: "string" as const },
          text_other: { type: "string" as const },
        },
      },
    };
    expect(elicitationQuestionsFromRequest(ordinaryRequest).map(({ id }) => id)).toEqual([
      "choice",
      "choice_other",
      "text",
      "text_other",
    ]);
    expect(
      elicitationResponseFromAnswers(ordinaryRequest, {
        choice: "other",
        choice_other: "Independent follow-up",
        text: "Custom",
        text_other: "Independent field",
      }),
    ).toEqual({
      action: "accept",
      content: {
        choice: "other",
        choice_other: "Independent follow-up",
        text: "Custom",
        text_other: "Independent field",
      },
    });
  });
});
