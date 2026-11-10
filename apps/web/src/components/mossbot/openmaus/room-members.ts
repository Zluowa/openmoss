// Adapted from OpenMaus @ 58378e8 (Apache-2.0). See third_party/openmaus/UI-PORTS.md.
export function nextMemberIds(current: string[], picked: Set<string>, order: string[]): string[] {
  return [
    ...current.filter((id) => picked.has(id)),
    ...order.filter((id) => picked.has(id) && !current.includes(id)),
  ];
}
