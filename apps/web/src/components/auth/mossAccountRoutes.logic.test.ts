import { describe, expect, it } from "vitest";

import { parseMossAccountRouteSearch } from "./mossAccountRoutes.logic";

describe("Moss account route", () => {
  it("accepts only the explicit global Google account view", () => {
    expect(parseMossAccountRouteSearch({ accountView: "google" })).toEqual({
      accountView: "google",
    });
    expect(parseMossAccountRouteSearch({ accountView: "phone" })).toEqual({});
    expect(parseMossAccountRouteSearch({ accountView: "google", extra: "ignored" })).toEqual({
      accountView: "google",
    });
    expect(parseMossAccountRouteSearch(null)).toEqual({});
  });
});
