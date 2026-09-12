export function now(): number {
  return Date.now();
}

export function monthPeriod(at: number = now()): string {
  return new Date(at).toISOString().slice(0, 7);
}
