export const OTP_TTL_MS = 10 * 60 * 1000;

export const OTP_MAX_ATTEMPTS = 5;

export const OTP_MAX_PER_HOUR = 3;

export function generateOtpCode(): string {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return ((buffer[0] ?? 0) % 1000000).toString().padStart(6, "0");
}
