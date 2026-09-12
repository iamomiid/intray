export interface ApiRoutingRule {
  tag?: string;
  id?: string;
  name?: string;
  enabled?: boolean;
  matchers?: Array<{ type?: string; field?: string; value?: string }>;
  actions?: Array<{ type?: string; value?: string[] }>;
}

export interface ZoneRule {
  ruleId: string;
  address: string;
}

export interface DeploymentInbox {
  inboxId: string;
  ruleId: string | null;
}

export interface AdoptedRule {
  inboxId: string;
  ruleId: string;
}

export interface RoutingPlan {
  create: string[];
  adopt: AdoptedRule[];
  remove: ZoneRule[];
}

function ruleId(rule: ApiRoutingRule): string {
  const value = rule.tag ?? rule.id;
  return typeof value === "string" ? value : "";
}

function ruleAddress(rule: ApiRoutingRule): string {
  const matcher = (rule.matchers ?? []).find(
    (entry) => entry.type === "literal" && entry.field === "to",
  );
  return matcher?.value?.trim().toLowerCase() ?? "";
}

export function zoneRules(rules: ApiRoutingRule[], worker: string): ZoneRule[] {
  return rules
    .filter((rule) =>
      (rule.actions ?? []).some(
        (action) => action.type === "worker" && (action.value ?? []).includes(worker),
      ),
    )
    .map((rule) => ({ ruleId: ruleId(rule), address: ruleAddress(rule) }))
    .filter((rule) => rule.ruleId !== "" && rule.address !== "");
}

export function parseInboxRows(rows: Record<string, unknown>[]): DeploymentInbox[] {
  return rows.flatMap((row) => {
    const inboxId = row.inbox_id;
    if (typeof inboxId !== "string" || inboxId === "") {
      return [];
    }
    const ruleId = row.routing_rule_id;
    return [
      {
        inboxId: inboxId.toLowerCase(),
        ruleId: typeof ruleId === "string" && ruleId !== "" ? ruleId : null,
      },
    ];
  });
}

export function planRouting(inboxes: DeploymentInbox[], rules: ZoneRule[]): RoutingPlan {
  const byAddress = new Map(rules.map((rule) => [rule.address, rule]));
  const addresses = new Set(inboxes.map((inbox) => inbox.inboxId));
  const matched = inboxes.map((inbox) => ({ inbox, rule: byAddress.get(inbox.inboxId) ?? null }));
  return {
    create: matched.filter((entry) => entry.rule === null).map((entry) => entry.inbox.inboxId),
    adopt: matched.flatMap((entry) =>
      entry.rule !== null && entry.inbox.ruleId !== entry.rule.ruleId
        ? [{ inboxId: entry.inbox.inboxId, ruleId: entry.rule.ruleId }]
        : [],
    ),
    remove: rules.filter((rule) => !addresses.has(rule.address)),
  };
}

export function isEmptyPlan(plan: RoutingPlan): boolean {
  return plan.create.length === 0 && plan.adopt.length === 0 && plan.remove.length === 0;
}

export function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function updateRuleIdsSql(entries: AdoptedRule[]): string {
  return entries
    .map(
      (entry) =>
        `UPDATE inboxes SET routing_rule_id = ${sqlText(entry.ruleId)} WHERE inbox_id = ${sqlText(entry.inboxId)};`,
    )
    .join(" ");
}
