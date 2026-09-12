import { monotonicFactory } from "ulid";

export type IdPrefix = "acc" | "key" | "thr" | "msg" | "att" | "drf" | "whk" | "dlv";

const nextUlid = monotonicFactory();

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${nextUlid().toLowerCase()}`;
}
