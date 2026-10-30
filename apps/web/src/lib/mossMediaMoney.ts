/** Wire amounts are nonnegative decimal integers; never round through Number. */
export function isMediaNanoAmount(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,29})$/u.test(value);
}

function formatNanoAmount(value: string, fractionDigits: number): string {
  if (!isMediaNanoAmount(value)) throw new Error("Invalid media amount");
  const padded = value.padStart(fractionDigits + 1, "0");
  const whole = padded.slice(0, -fractionDigits).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const fraction = padded.slice(-fractionDigits).replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** 100 media points per CNY; one nano-CNY is exactly 0.0000001 points. */
export function formatMediaPoints(nanoCny: string): string {
  return formatNanoAmount(nanoCny, 7);
}

export function formatMediaOriginalCost(nanoAmount: string): string {
  return formatNanoAmount(nanoAmount, 9);
}
