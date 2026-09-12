import { badRequest } from "../lib/errors";
import { LABEL_MAX_CHARS } from "../lib/limits";

export const MAX_LABELS = 20;

export interface LabelDelta {
  add: string[];
  remove: string[];
}

export function normalizeLabels(value: unknown, field = "labels"): string[] {
  if (!Array.isArray(value)) {
    throw badRequest(`${field} must be an array of strings`);
  }
  const labels: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw badRequest(`${field} must be an array of strings`);
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      throw badRequest(`${field} must not be empty`);
    }
    if (trimmed.length > LABEL_MAX_CHARS) {
      throw badRequest(`${field} must be at most ${LABEL_MAX_CHARS} characters`);
    }
    if (!labels.includes(trimmed)) {
      labels.push(trimmed);
    }
  }
  if (labels.length > MAX_LABELS) {
    throw badRequest(`at most ${MAX_LABELS} labels`);
  }
  return labels;
}

export function normalizeLabelDelta(add: unknown, remove: unknown): LabelDelta {
  const delta: LabelDelta = {
    add: add === undefined || add === null ? [] : normalizeLabels(add, "add"),
    remove: remove === undefined || remove === null ? [] : normalizeLabels(remove, "remove"),
  };
  if (delta.add.length === 0 && delta.remove.length === 0) {
    throw badRequest("add or remove must list at least one label");
  }
  return delta;
}

export function applyLabelDelta(current: string[], delta: LabelDelta): string[] {
  const labels = current.filter((label) => !delta.remove.includes(label));
  for (const label of delta.add) {
    if (!labels.includes(label)) {
      labels.push(label);
    }
  }
  if (labels.length > MAX_LABELS) {
    throw badRequest(`at most ${MAX_LABELS} labels`);
  }
  return labels;
}
