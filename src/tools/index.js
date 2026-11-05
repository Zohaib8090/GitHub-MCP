import repos from "./specs/repos.js";
import issues from "./specs/issues.js";
import pulls from "./specs/pulls.js";
import actions from "./specs/actions.js";
import security from "./specs/security.js";
import misc from "./specs/misc.js";
import custom from "./custom.js";
import { parseSpec, registerSpec } from "./dsl.js";
import { wrap } from "../core.js";

// Names of the tools that live inline in server.js (always on). Used to catch collisions.
export const BUILTIN = ["gh_whoami", "gh_list_repos", "gh_get_repo", "gh_update_repo", "gh_list_workflows", "gh_list_runs", "gh_get_run_jobs",
  "gh_get_job_logs", "gh_dispatch_workflow", "gh_rerun_run", "gh_cancel_run", "gh_set_actions_secret", "gh_list_secret_names", "gh_create_release",
  "gh_upload_release_asset", "gh_get_branch_protection", "gh_set_branch_protection", "gh_list_webhooks", "gh_create_webhook", "gh_delete_webhook",
  "gh_get_pages", "gh_enable_pages", "gh_list_deploy_keys", "gh_delete_repo", "gh_api"];

const specs = [];
for (const group of [repos, issues, pulls, actions, security, misc]) {
  for (const [toolset, list] of Object.entries(group)) for (const raw of list) specs.push(parseSpec(toolset, raw));
}
const customTools = custom.map((c) => ({ ...c, handler: wrap(c.handler) }));

const seen = new Set(BUILTIN);
for (const t of [...specs, ...customTools]) {
  if (seen.has(t.name)) throw new Error(`Duplicate tool name: ${t.name}`);
  seen.add(t.name);
}

export const TOOLSETS = [...new Set([...specs, ...customTools].map((t) => t.toolset))].sort();
export const ALL_SPECS = specs;
export const ALL_CUSTOM = customTools;

// GITHUB_TOOLSETS=all (default) | "repos,issues,pulls" | "all,-codespaces,-packages"
export function enabledToolsets(value = process.env.GITHUB_TOOLSETS) {
  const parts = (value || "all").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const positives = parts.filter((p) => !p.startsWith("-"));
  const negatives = parts.filter((p) => p.startsWith("-")).map((p) => p.slice(1));
  const base = !positives.length || positives.includes("all") ? TOOLSETS : positives;
  const unknown = [...base, ...negatives].filter((t) => t !== "all" && !TOOLSETS.includes(t));
  if (unknown.length) console.error(`GITHUB_TOOLSETS: unknown toolset(s) ${unknown.join(", ")}. Available: ${TOOLSETS.join(", ")}`);
  return new Set(base.filter((t) => !negatives.includes(t)));
}

const active = enabledToolsets();
export function registerAllTools(s) {
  for (const sp of specs) if (active.has(sp.toolset)) registerSpec(s, sp);
  for (const c of customTools) if (active.has(c.toolset)) s.tool(c.name, c.description, c.shape, c.handler);
}
export const activeToolsets = () => [...active].sort();
export function toolCount() {
  return BUILTIN.length + specs.filter((t) => active.has(t.toolset)).length + customTools.filter((t) => active.has(t.toolset)).length;
}
