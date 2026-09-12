import { readWranglerConfig } from "../config.ts";
import type { Outcome, SetupContext, Step } from "../context.ts";
import { defineStep, done, saveConfig, skipped } from "../context.ts";
import { SetupError } from "../errors.ts";
import { parseBucketNames, parseD1Databases, parseDatabaseId } from "../parse.ts";
import { indent } from "../runtime.ts";
import { wrangler } from "../wrangler.ts";

export const DATABASE = "intray";

export const BUCKET = "intray";

export const QUEUE = "intray-webhooks";

interface EnsuredDatabase {
  databaseId: string;
  created: boolean;
}

function ensureDatabase(context: SetupContext, step: string): EnsuredDatabase {
  const list = wrangler(step, ["d1", "list", "--json"], context.root, { allowFailure: true });
  const existing =
    list.status === 0
      ? parseD1Databases(list.output).find((database) => database.name === DATABASE)
      : undefined;
  if (existing !== undefined && existing.uuid !== "") {
    return { databaseId: existing.uuid, created: false };
  }

  const create = wrangler(step, ["d1", "create", DATABASE], context.root);
  const parsed = parseDatabaseId(create.output);
  if (parsed === null) {
    throw new SetupError(
      step,
      `created the database but found no uuid in the output\n${indent(create.output.trim())}`,
    );
  }
  return { databaseId: parsed, created: true };
}

async function runD1(context: SetupContext, step: string): Promise<Outcome> {
  const { databaseId, created } = ensureDatabase(context, step);

  const config = readWranglerConfig(context.configPath);
  const binding = config.d1_databases?.[0];
  if (binding === undefined) {
    throw new SetupError(step, "wrangler.jsonc has no d1_databases entry");
  }
  if (binding.database_id === databaseId) {
    return skipped(`database_id already ${databaseId}`);
  }
  binding.database_id = databaseId;
  saveConfig(context, config);
  return done(created ? `created ${databaseId}` : `wrote database_id ${databaseId}`);
}

async function runR2(context: SetupContext, step: string): Promise<Outcome> {
  const list = wrangler(step, ["r2", "bucket", "list"], context.root);
  if (parseBucketNames(list.output).includes(BUCKET)) {
    return skipped(`bucket ${BUCKET} exists`);
  }
  wrangler(step, ["r2", "bucket", "create", BUCKET], context.root);
  return done(`created bucket ${BUCKET}`);
}

async function runQueue(context: SetupContext, step: string): Promise<Outcome> {
  const info = wrangler(step, ["queues", "info", QUEUE], context.root, { allowFailure: true });
  if (info.status === 0) {
    return skipped(`queue ${QUEUE} exists`);
  }
  wrangler(step, ["queues", "create", QUEUE], context.root);
  return done(`created queue ${QUEUE}`);
}

async function runMigrations(context: SetupContext, step: string): Promise<Outcome> {
  const result = wrangler(step, ["d1", "migrations", "apply", DATABASE, "--remote"], context.root);
  if (/No migrations to apply/i.test(result.output)) {
    return skipped("no migrations to apply");
  }
  return done("applied");
}

export const resourceSteps: Step[] = [
  defineStep("D1 database", runD1),
  defineStep("R2 bucket", runR2),
  defineStep("Queue", runQueue),
  defineStep("Migrations", runMigrations),
];
