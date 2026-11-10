// Reflection on the native slots ignores shadowed length/buffer properties and
// accepts Buffer slices while excluding shared backing, proxies and other views.
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedTag = Object.getOwnPropertyDescriptor(typedPrototype, Symbol.toStringTag)!.get!;
const typedBuffer = Object.getOwnPropertyDescriptor(typedPrototype, "buffer")!.get!;
const typedLength = Object.getOwnPropertyDescriptor(typedPrototype, "byteLength")!.get!;
const ordinaryBufferLength = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)!.get!;

export function ordinaryByteViewLength(value: unknown): number | null {
  try {
    if (Reflect.apply(typedTag, value, []) !== "Uint8Array") return null;
    const buffer = Reflect.apply(typedBuffer, value, []);
    Reflect.apply(ordinaryBufferLength, buffer, []);
    return Reflect.apply(typedLength, value, []);
  } catch {
    return null;
  }
}

export function copyOrdinaryByteView(
  value: unknown,
  maximum: number,
  minimum = 0,
): Uint8Array<ArrayBuffer> | null {
  const length = ordinaryByteViewLength(value);
  if (length === null || length < minimum || length > maximum) return null;
  try {
    const copy = new Uint8Array(value as Uint8Array);
    return copy.byteLength === length ? copy : null;
  } catch {
    return null;
  }
}
