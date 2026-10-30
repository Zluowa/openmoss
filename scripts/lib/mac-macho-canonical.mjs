// Shared normalization after codesign --remove-signature on an owned copy.
// codesign may resize __LINKEDIT's virtual mapping without changing its content.
export function normalizeSignatureStrippedMachO(bytes, label) {
  const headerSize = 32;
  if (bytes.length < headerSize || bytes.readUInt32LE(0) !== 0xfeedfacf) {
    throw new Error(
      `Bundled Codex signed payload canonicalization requires a little-endian thin 64-bit Mach-O for ${label}.`,
    );
  }
  const commandCount = bytes.readUInt32LE(16);
  const commandsEnd = headerSize + bytes.readUInt32LE(20);
  if (commandCount === 0 || commandCount > 65_535 || commandsEnd > bytes.length) {
    throw new Error(`Bundled Codex signed payload has invalid Mach-O load commands for ${label}.`);
  }
  const normalized = Buffer.from(bytes);
  let cursor = headerSize;
  let linkeditVmSizeOffset = null;
  for (let index = 0; index < commandCount; index += 1) {
    if (cursor + 8 > commandsEnd) {
      throw new Error(`Bundled Codex signed payload has truncated Mach-O commands for ${label}.`);
    }
    const command = normalized.readUInt32LE(cursor);
    const commandSize = normalized.readUInt32LE(cursor + 4);
    if (commandSize < 8 || cursor + commandSize > commandsEnd) {
      throw new Error(
        `Bundled Codex signed payload has invalid Mach-O command bounds for ${label}.`,
      );
    }
    if (command === 0x19) {
      if (commandSize < 72) {
        throw new Error(
          `Bundled Codex signed payload has a truncated segment command for ${label}.`,
        );
      }
      const name = normalized
        .subarray(cursor + 8, cursor + 24)
        .toString("ascii")
        .split("\0")[0];
      if (name === "__LINKEDIT") {
        if (linkeditVmSizeOffset !== null) {
          throw new Error(
            `Bundled Codex signed payload has duplicate __LINKEDIT segments for ${label}.`,
          );
        }
        const offset = normalized.readBigUInt64LE(cursor + 40);
        const size = normalized.readBigUInt64LE(cursor + 48);
        if (offset + size > BigInt(normalized.length)) {
          throw new Error(
            `Bundled Codex signed payload has an out-of-bounds __LINKEDIT segment for ${label}.`,
          );
        }
        linkeditVmSizeOffset = cursor + 32;
      }
    }
    cursor += commandSize;
  }
  if (cursor !== commandsEnd || linkeditVmSizeOffset === null) {
    throw new Error(
      `Bundled Codex signed payload requires exactly one bounded __LINKEDIT segment for ${label}.`,
    );
  }
  normalized.writeBigUInt64LE(0n, linkeditVmSizeOffset);
  return normalized;
}
