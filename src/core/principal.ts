import type { AccountRow } from "../db/rows";

export interface Principal {
  account: AccountRow;
  keyId: string;
  pending: boolean;
}

export function isVerified(principal: Principal): boolean {
  return principal.account.verified_at !== null;
}
