const emitted = new Set<string>();

export function warnOnce(message: string): void {
  if (emitted.has(message)) {
    return;
  }
  emitted.add(message);
  console.warn(message);
}
