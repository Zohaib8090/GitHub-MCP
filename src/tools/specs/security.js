// Dependabot, code scanning, secret scanning, advisories, dependency graph, rulesets.
const RP = "/repos/{owner}/{repo}";

export default {
  security: [
    ["gh_list_dependabot_alerts", `GET ${RP}/dependabot/alerts`, "Dependabot alerts.", "q.state?:s q.severity?:s q.ecosystem?:s q.package?:s q.scope?:e(development|runtime) q.sort?:e(created|updated)", { pick: ["number", "state", "dependency.package.name", "dependency.package.ecosystem", "security_advisory.summary", "security_advisory.severity", "security_advisory.cve_id", "security_vulnerability.first_patched_version.identifier", "html_url"] }],
    ["gh_get_dependabot_alert", `GET ${RP}/dependabot/alerts/{alert_number:n}`, "One Dependabot alert."],
    ["gh_update_dependabot_alert", `PATCH ${RP}/dependabot/alerts/{alert_number:n}`, "Dismiss or reopen a Dependabot alert.", "b.state:e(dismissed|open) b.dismissed_reason?:e(fix_started|inaccurate|no_bandwidth|not_used|tolerable_risk) b.dismissed_comment?:s"],
    ["gh_list_code_scanning_alerts", `GET ${RP}/code-scanning/alerts`, "Code scanning (CodeQL etc.) alerts.", "q.state?:e(open|closed|dismissed|fixed) q.ref?:s q.severity?:s q.tool_name?:s", { pick: ["number", "state", "rule.id", "rule.severity", "rule.description", "tool.name", "most_recent_instance.location", "html_url"] }],
    ["gh_get_code_scanning_alert", `GET ${RP}/code-scanning/alerts/{alert_number:n}`, "One code scanning alert."],
    ["gh_update_code_scanning_alert", `PATCH ${RP}/code-scanning/alerts/{alert_number:n}`, "Dismiss or reopen a code scanning alert.", "b.state:e(open|dismissed) b.dismissed_reason?:s b.dismissed_comment?:s"],
    ["gh_list_code_scanning_instances", `GET ${RP}/code-scanning/alerts/{alert_number:n}/instances`, "Where a code scanning alert occurs."],
    ["gh_list_code_scanning_analyses", `GET ${RP}/code-scanning/analyses`, "Code scanning analyses.", "q.ref?:s q.tool_name?:s", { pick: ["id", "ref", "commit_sha", "tool.name", "created_at", "results_count", "rules_count"] }],
    ["gh_list_secret_scanning_alerts", `GET ${RP}/secret-scanning/alerts`, "Secret scanning alerts.", "q.state?:e(open|resolved) q.secret_type?:s q.resolution?:s", { pick: ["number", "state", "secret_type_display_name", "resolution", "created_at", "html_url", "push_protection_bypassed"] }],
    ["gh_get_secret_scanning_alert", `GET ${RP}/secret-scanning/alerts/{alert_number:n}`, "One secret scanning alert."],
    ["gh_update_secret_scanning_alert", `PATCH ${RP}/secret-scanning/alerts/{alert_number:n}`, "Resolve or reopen a secret scanning alert.", "b.state:e(open|resolved) b.resolution?:e(false_positive|wont_fix|revoked|used_in_tests) b.resolution_comment?:s"],
    ["gh_list_secret_scanning_locations", `GET ${RP}/secret-scanning/alerts/{alert_number:n}/locations`, "Where the leaked secret appears."],
    ["gh_list_repo_advisories", `GET ${RP}/security-advisories`, "Repository security advisories.", "q.state?:e(triage|draft|published|closed)", { pick: ["ghsa_id", "summary", "severity", "state", "cve_id", "html_url"] }],
    ["gh_get_repo_advisory", `GET ${RP}/security-advisories/{ghsa_id}`, "One repository security advisory."],
    ["gh_create_repo_advisory", `POST ${RP}/security-advisories`, "Draft a repository security advisory.", "b.summary:s b.description:s b.vulnerabilities:oa b.severity?:e(critical|high|medium|low) b.cve_id?:s b.cwe_ids?:sa"],
    ["gh_update_repo_advisory", `PATCH ${RP}/security-advisories/{ghsa_id}`, "Edit / publish / close an advisory.", "b.summary?:s b.description?:s b.severity?:s b.state?:e(published|closed|draft) b.vulnerabilities?:oa b.cve_id?:s"],
    ["gh_list_global_advisories", "GET /advisories", "Search the GitHub Advisory Database.", "q.ecosystem?:s q.severity?:s q.cve_id?:s q.ghsa_id?:s q.affects?:s q.type?:e(reviewed|malware|unreviewed)", { pick: ["ghsa_id", "cve_id", "summary", "severity", "html_url", "published_at"] }],
    ["gh_get_global_advisory", "GET /advisories/{ghsa_id}", "One advisory from the Advisory Database."],
    ["gh_get_sbom", `GET ${RP}/dependency-graph/sbom`, "Software bill of materials (SPDX) for the repo."],
    ["gh_compare_dependencies", `GET ${RP}/dependency-graph/compare/{basehead*}`, "Dependency changes between two refs ('main...feature')."],
  ],

  rulesets: [
    ["gh_list_rulesets", `GET ${RP}/rulesets`, "Repository rulesets.", "q.includes_parents?:b", { pick: ["id", "name", "target", "enforcement", "source_type"] }],
    ["gh_get_ruleset", `GET ${RP}/rulesets/{ruleset_id:n}`, "One ruleset with its rules."],
    ["gh_create_ruleset", `POST ${RP}/rulesets`, "Create a ruleset. rules e.g. [{type:'pull_request',parameters:{...}}], conditions e.g. {ref_name:{include:['~DEFAULT_BRANCH'],exclude:[]}}.", "b.name:s b.target?:e(branch|tag|push) b.enforcement:e(disabled|active|evaluate) b.conditions?:o b.rules?:oa b.bypass_actors?:oa"],
    ["gh_update_ruleset", `PUT ${RP}/rulesets/{ruleset_id:n}`, "Update a ruleset.", "b.name?:s b.target?:e(branch|tag|push) b.enforcement?:e(disabled|active|evaluate) b.conditions?:o b.rules?:oa b.bypass_actors?:oa"],
    ["gh_delete_ruleset", `DELETE ${RP}/rulesets/{ruleset_id:n}`, "Delete a ruleset.", "", { destructive: true }],
    ["gh_get_rules_for_branch", `GET ${RP}/rules/branches/{branch*}`, "All rules that apply to a branch."],
    ["gh_delete_branch_protection", `DELETE ${RP}/branches/{branch*}/protection`, "Remove classic branch protection.", "", { destructive: true }],
    ["gh_list_org_rulesets", "GET /orgs/{org}/rulesets", "Organization rulesets.", "", { pick: ["id", "name", "target", "enforcement"] }],
  ],
};
