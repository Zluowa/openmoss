// FILE: ownerDeviceSession.test.ts
// Purpose: Session provenance for the owner's phones.
// Layer: Shared pure logic tests
// Exports: none
import { describe, expect, it } from "vitest";

import {
  OWNER_DEVICE_SUBJECT,
  accountDeviceSubject,
  isAccountDeviceSubject,
  isOwnerDeviceSubject,
} from "./ownerDeviceSession";

describe("owner device session subjects", () => {
  const accountA = accountDeviceSubject("memfire-phone", "key-a");

  it("counts code-paired and account-created phones as owner devices, nothing else", () => {
    expect(isOwnerDeviceSubject(OWNER_DEVICE_SUBJECT)).toBe(true);
    expect(isOwnerDeviceSubject(accountA)).toBe(true);
    expect(isOwnerDeviceSubject("owner-bootstrap")).toBe(false);
    expect(isOwnerDeviceSubject("owner-devices")).toBe(false);
    expect(isOwnerDeviceSubject("browser")).toBe(false);
  });

  it("matches account sessions exactly by realm and account", () => {
    expect(isAccountDeviceSubject(OWNER_DEVICE_SUBJECT)).toBe(false);
    expect(isAccountDeviceSubject(accountA)).toBe(true);
    expect(isAccountDeviceSubject(accountA, { realm: "memfire-phone" })).toBe(true);
    expect(isAccountDeviceSubject(accountA, { realm: "supabase-google" })).toBe(false);
    expect(isAccountDeviceSubject(accountA, { realm: "memfire-phone", accountKey: "key-a" })).toBe(
      true,
    );
    expect(isAccountDeviceSubject(accountA, { realm: "memfire-phone", accountKey: "key" })).toBe(
      false,
    );
  });
});
