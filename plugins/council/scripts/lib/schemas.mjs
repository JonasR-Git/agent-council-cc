import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../schemas");

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(DIR, `${name}.schema.json`), "utf8"));
}

export const SCHEMAS = Object.freeze({
  findings: load("findings"),
  plan: load("plan"),
  critiqueVotes: load("critique-votes"),
  planCritique: load("plan-critique"),
  debateRebuttal: load("debate-rebuttal"),
  debateCounter: load("debate-counter"),
  auditFinding: load("audit-finding")
});
