import { describe, expect, it } from "vitest";
import {
  isPlaintextOrigin,
  phoneAccessProblemKey,
  phoneOriginLabel,
  phonePairingOrigins,
  phonePairingUrl,
} from "./phonePairingModel";

describe("phonePairingModel", () => {
  it("prefers the configured secure origin, then distinct same-network origins", () => {
    expect(
      phonePairingOrigins({
        shareableOrigin: "https://moss.example.com",
        lanOrigins: ["http://192.168.1.42:3773", "http://192.168.1.42:3773"],
      }),
    ).toEqual(["https://moss.example.com", "http://192.168.1.42:3773"]);
    expect(phonePairingOrigins({})).toEqual([]);
  });

  it("keeps the credential in the fragment of the /pair link", () => {
    const url = new URL(phonePairingUrl("http://192.168.1.42:3773", "abc+/="));
    expect(url.pathname).toBe("/pair");
    expect(url.search).toBe("");
    expect(new URLSearchParams(url.hash.slice(1)).get("token")).toBe("abc+/=");
  });

  it("labels and classifies origins", () => {
    expect(phoneOriginLabel("http://100.101.1.2:3773")).toBe("100.101.1.2");
    expect(isPlaintextOrigin("http://192.168.1.42:3773")).toBe(true);
    expect(isPlaintextOrigin("https://moss.example.com")).toBe(false);
  });

  it("names the one reason phones cannot connect from the desktop", () => {
    expect(phoneAccessProblemKey({ unavailableReason: null, error: null })).toBeNull();
    expect(phoneAccessProblemKey({ unavailableReason: "development", error: null })).toBe(
      "settings.phone.access.development",
    );
    expect(phoneAccessProblemKey({ unavailableReason: null, error: "port-unavailable" })).toBe(
      "settings.phone.access.error.port",
    );
    expect(phoneAccessProblemKey({ unavailableReason: null, error: "restart-failed" })).toBe(
      "settings.phone.access.error.restart",
    );
  });
});
