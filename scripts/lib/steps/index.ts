import type { Step } from "../context.ts";
import { accountSteps } from "./account.ts";
import { deploySteps } from "./deploy.ts";
import { mailSteps } from "./mail.ts";
import { resourceSteps } from "./resources.ts";

export const steps: Step[] = [...accountSteps, ...resourceSteps, ...deploySteps, ...mailSteps];
