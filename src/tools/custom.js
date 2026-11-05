// Multi-step tools that don't fit the declarative DSL.
import { z } from "zod";
import { gh, wrap, assertRepo, assertWritable, assertDestructive, audit, FULL_CONTROL, R } from "../core.js";

const enc = (s) => String(s).split("/").map(encodeURIComponent).join("/");
const RP = (a) => `/repos/${a.owner}/${a.repo}`;
const status = (e) => Number(/^GitHub (\d+)/.exec(e?.message || "")?.[1] || 0);
const b64 = (content, encoding = "utf-8") => (encoding === "base64" ? content.replace(/\s+/g, "") : Buffer.from(content, "utf8").toString("base64"));
const cut = (text, max = 100_000, offset = 0) => {
  const slice = text.slice(offset, offset + max);
  return offset + max < text.length ? `${slice}\n…[truncated at ${offset + max} of ${text.length} chars; pass offset=${offset + max} for more]` : slice;
};
const write = (name, a, detail = {}) => { assertRepo(a.owner, a.repo); assertWritable(); audit(name, { owner: a.owner, repo: a.repo, ...detail }); };
const guardedGlobalWrite = (name, detail) => {
  if (!FULL_CONTROL) throw new Error(`${name} needs FULL_CONTROL=true (it acts outside a single allow-listed repo)`);
  audit(name, detail);
};

async function defaultBranch(a) { return (await gh("GET", RP(a))).default_branch; }
async function resolveSha(a, ref) {
  if (/^[0-9a-f]{40}$/i.test(ref)) return ref;
  return (await gh("GET", `${RP(a)}/commits/${enc(ref)}`, { headers: { Accept: "application/vnd.github.sha" } }));
}
async function graphql(query, variables) {
  const d = await gh("POST", "/graphql", { body: { query, variables } });
  if (d.errors?.length) throw new Error(`GraphQL: ${JSON.stringify(d.errors)}`);
  return d.data;
}
async function sealedSecret(base, name, value) {
  const sodium = (await import("libsodium-wrappers")).default; await sodium.ready;
  const pk = await gh("GET", `${base}/secrets/public-key`);
  const key = sodium.from_base64(pk.key, sodium.base64_variants.ORIGINAL);
  const enc64 = sodium.to_base64(sodium.crypto_box_seal(sodium.from_string(value), key), sodium.base64_variants.ORIGINAL);
  return { encrypted_value: enc64, key_id: pk.key_id };
}
const PERSON = z.object({ name: z.string(), email: z.string() }).optional();

export default [
  // ------------------------------------------------------------------ repos
  { toolset: "repos", name: "gh_create_repo",
    description: "Create a repository for you (or in an organization). Private by default; can add README, license, .gitignore.",
    shape: { name: z.string(), org: z.string().optional(), description: z.string().optional(), homepage: z.string().optional(),
      private: z.boolean().default(true), auto_init: z.boolean().default(true), license_template: z.string().optional(),
      gitignore_template: z.string().optional(), is_template: z.boolean().optional(), has_issues: z.boolean().optional(),
      has_wiki: z.boolean().optional(), has_projects: z.boolean().optional(), default_branch: z.string().optional() },
    async handler({ org, default_branch, ...body }) {
      const owner = org || (await gh("GET", "/user")).login;
      assertRepo(owner, body.name); assertWritable(); audit("create_repo", { owner, name: body.name });
      const r = await gh("POST", org ? `/orgs/${encodeURIComponent(org)}/repos` : "/user/repos", { body });
      if (default_branch && default_branch !== r.default_branch) {
        await gh("POST", `/repos/${r.full_name}/branches/${enc(r.default_branch)}/rename`, { body: { new_name: default_branch } });
      }
      return { full_name: r.full_name, url: r.html_url, private: r.private, default_branch: default_branch || r.default_branch, clone_url: r.clone_url };
    } },

  { toolset: "repos", name: "gh_create_branch",
    description: "Create a branch from another branch, tag or commit sha (default: the repo's default branch).",
    shape: { ...R, branch: z.string(), from: z.string().optional().describe("branch, tag or sha; default = default branch") },
    async handler(a) {
      write("create_branch", a, { branch: a.branch });
      const sha = await resolveSha(a, a.from || (await defaultBranch(a)));
      const ref = await gh("POST", `${RP(a)}/git/refs`, { body: { ref: `refs/heads/${a.branch}`, sha } });
      return { ref: ref.ref, sha: ref.object.sha };
    } },

  { toolset: "repos", name: "gh_create_tag",
    description: "Create a tag (lightweight, or annotated when a message is given) at a branch/sha.",
    shape: { ...R, tag: z.string(), target: z.string().optional().describe("branch, tag or sha; default = default branch"), message: z.string().optional(), tagger: PERSON },
    async handler(a) {
      write("create_tag", a, { tag: a.tag });
      const sha = await resolveSha(a, a.target || (await defaultBranch(a)));
      let objSha = sha;
      if (a.message) {
        const t = await gh("POST", `${RP(a)}/git/tags`, { body: { tag: a.tag, message: a.message, object: sha, type: "commit", tagger: a.tagger } });
        objSha = t.sha;
      }
      const ref = await gh("POST", `${RP(a)}/git/refs`, { body: { ref: `refs/tags/${a.tag}`, sha: objSha } });
      return { ref: ref.ref, sha: ref.object.sha, annotated: !!a.message };
    } },

  { toolset: "repos", name: "gh_update_ref",
    description: "Move a branch/tag ref to a new sha. force=true allows non-fast-forward (DESTRUCTIVE).",
    shape: { ...R, ref: z.string().describe("e.g. heads/main"), sha: z.string(), force: z.boolean().default(false), confirm: z.string().optional() },
    async handler(a) {
      const path = `${RP(a)}/git/refs/${enc(a.ref)}`;
      write("update_ref", a, { ref: a.ref, force: a.force });
      if (a.force) assertDestructive(a.confirm, path);
      const r = await gh("PATCH", path, { body: { sha: a.sha, force: a.force } });
      return { ref: r.ref, sha: r.object.sha };
    } },

  { toolset: "repos", name: "gh_list_files",
    description: "List every file path in a repo at a ref (recursive tree), optionally under a prefix. Good for exploring a codebase.",
    shape: { ...R, ref: z.string().optional(), path_prefix: z.string().optional(), limit: z.number().default(1000) },
    async handler(a) {
      assertRepo(a.owner, a.repo);
      const ref = a.ref || (await defaultBranch(a));
      const t = await gh("GET", `${RP(a)}/git/trees/${enc(ref)}`, { query: { recursive: "1" } });
      let items = t.tree.filter((x) => x.type === "blob");
      if (a.path_prefix) items = items.filter((x) => x.path.startsWith(a.path_prefix));
      return { ref, truncated: !!t.truncated || items.length > a.limit, total: items.length, files: items.slice(0, a.limit).map((x) => ({ path: x.path, size: x.size })) };
    } },

  // ------------------------------------------------------------------ files
  { toolset: "git", name: "gh_get_file",
    description: "Read a file (decoded text) or list a directory. Large files are returned in chunks (max_chars/offset).",
    shape: { ...R, path: z.string(), ref: z.string().optional(), max_chars: z.number().default(100000), offset: z.number().default(0) },
    async handler(a) {
      assertRepo(a.owner, a.repo);
      const d = await gh("GET", `${RP(a)}/contents/${enc(a.path)}`, { query: { ref: a.ref } });
      if (Array.isArray(d)) return d.map((x) => ({ name: x.name, type: x.type, size: x.size, path: x.path }));
      let text;
      if (d.encoding === "base64" && d.content) text = Buffer.from(d.content, "base64").toString("utf8");
      else text = await gh("GET", `${RP(a)}/contents/${enc(a.path)}`, { query: { ref: a.ref }, headers: { Accept: "application/vnd.github.raw+json" } });
      if (typeof text !== "string") text = JSON.stringify(text);
      return { path: d.path, sha: d.sha, size: d.size, content: cut(text, a.max_chars, a.offset) };
    } },

  { toolset: "git", name: "gh_put_file",
    description: "Create or update ONE file with a commit (sha is looked up automatically). For several files use gh_push_files.",
    shape: { ...R, path: z.string(), content: z.string(), message: z.string(), branch: z.string().optional(), encoding: z.enum(["utf-8", "base64"]).default("utf-8"), sha: z.string().optional(), author: PERSON, committer: PERSON },
    async handler(a) {
      write("put_file", a, { path: a.path, branch: a.branch });
      let sha = a.sha;
      if (!sha) {
        try { const cur = await gh("GET", `${RP(a)}/contents/${enc(a.path)}`, { query: { ref: a.branch } }); if (!Array.isArray(cur)) sha = cur.sha; }
        catch (e) { if (status(e) !== 404) throw e; }
      }
      const r = await gh("PUT", `${RP(a)}/contents/${enc(a.path)}`, { body: { message: a.message, content: b64(a.content, a.encoding), branch: a.branch, sha, author: a.author, committer: a.committer } });
      return { commit: r.commit.sha, url: r.commit.html_url, file_sha: r.content.sha, created: !sha };
    } },

  { toolset: "git", name: "gh_delete_file",
    description: "Delete ONE file with a commit (sha looked up automatically). DESTRUCTIVE.",
    shape: { ...R, path: z.string(), message: z.string(), branch: z.string().optional(), confirm: z.string().optional() },
    async handler(a) {
      write("delete_file", a, { path: a.path });
      assertDestructive(a.confirm, `${a.owner}/${a.repo}:${a.path}`);
      const cur = await gh("GET", `${RP(a)}/contents/${enc(a.path)}`, { query: { ref: a.branch } });
      if (Array.isArray(cur)) throw new Error("path is a directory; use gh_push_files with delete entries");
      const r = await gh("DELETE", `${RP(a)}/contents/${enc(a.path)}`, { body: { message: a.message, sha: cur.sha, branch: a.branch } });
      return { commit: r.commit.sha, url: r.commit.html_url };
    } },

  { toolset: "git", name: "gh_push_files",
    description: "Commit MANY files (adds, edits, deletes) in a single commit. Creates the branch if missing (from base or the default branch) and works on empty repos. files: [{path, content, encoding?}] or [{path, delete:true}].",
    shape: { ...R, branch: z.string().optional().describe("default = default branch"), message: z.string(), base: z.string().optional().describe("branch to create `branch` from if it doesn't exist"),
      files: z.array(z.object({ path: z.string(), content: z.string().optional(), encoding: z.enum(["utf-8", "base64"]).optional(), delete: z.boolean().optional() })).min(1).max(200),
      author: PERSON, force: z.boolean().default(false), confirm: z.string().optional() },
    async handler(a) {
      write("push_files", a, { branch: a.branch, files: a.files.length });
      for (const f of a.files) if (!f.delete && f.content === undefined) throw new Error(`file ${f.path}: content or delete required`);
      let branch = a.branch;
      let files = a.files;
      let bootstrapped = null;
      if (!branch) { try { branch = await defaultBranch(a); } catch { throw new Error("could not read repo"); } }
      let head = null;
      const getHead = async () => { try { return (await gh("GET", `${RP(a)}/git/ref/heads/${enc(branch)}`)).object.sha; } catch (e) { if ([404, 409].includes(status(e))) return { err: status(e) }; throw e; } };
      head = await getHead();
      if (head?.err === 409 || (head?.err === 404 && (await gh("GET", RP(a))).size === 0 && !(await gh("GET", `${RP(a)}/branches`)).length)) {
        // empty repository: the contents API creates the first commit
        const first = files.find((f) => !f.delete);
        if (!first) throw new Error("repository is empty; nothing to delete");
        const r = await gh("PUT", `${RP(a)}/contents/${enc(first.path)}`, { body: { message: a.message, content: b64(first.content, first.encoding), branch } });
        bootstrapped = r.commit.sha;
        files = files.filter((f) => f !== first);
        if (!files.length) return { commit: bootstrapped, branch, url: r.commit.html_url, note: "empty repo bootstrapped" };
        head = await getHead();
      }
      if (head?.err === 404) {
        const from = await resolveSha(a, a.base || (await defaultBranch(a)));
        await gh("POST", `${RP(a)}/git/refs`, { body: { ref: `refs/heads/${branch}`, sha: from } });
        head = from;
      }
      const parent = await gh("GET", `${RP(a)}/git/commits/${head}`);
      const tree = [];
      for (const f of files) {
        if (f.delete) { tree.push({ path: f.path, mode: "100644", type: "blob", sha: null }); continue; }
        const blob = await gh("POST", `${RP(a)}/git/blobs`, { body: { content: b64(f.content, f.encoding), encoding: "base64" } });
        tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
      }
      const newTree = await gh("POST", `${RP(a)}/git/trees`, { body: { base_tree: parent.tree.sha, tree } });
      const commit = await gh("POST", `${RP(a)}/git/commits`, { body: { message: a.message, tree: newTree.sha, parents: [head], author: a.author } });
      if (a.force) assertDestructive(a.confirm, `${RP(a)}/git/refs/heads/${enc(branch)}`);
      await gh("PATCH", `${RP(a)}/git/refs/heads/${enc(branch)}`, { body: { sha: commit.sha, force: a.force } });
      return { commit: commit.sha, branch, url: commit.html_url, files: a.files.length, ...(bootstrapped ? { bootstrap_commit: bootstrapped } : {}) };
    } },

  // ------------------------------------------------------------------ pulls
  { toolset: "pulls", name: "gh_get_pull_diff",
    description: "The unified diff (or .patch) of a whole pull request as text.",
    shape: { ...R, pull_number: z.number(), format: z.enum(["diff", "patch"]).default("diff"), max_chars: z.number().default(100000), offset: z.number().default(0) },
    async handler(a) {
      assertRepo(a.owner, a.repo);
      const t = await gh("GET", `${RP(a)}/pulls/${a.pull_number}`, { headers: { Accept: `application/vnd.github.${a.format}` } });
      return cut(typeof t === "string" ? t : JSON.stringify(t), a.max_chars, a.offset);
    } },

  { toolset: "pulls", name: "gh_request_copilot_review",
    description: "Ask GitHub Copilot to review a pull request.",
    shape: { ...R, pull_number: z.number() },
    async handler(a) {
      write("copilot_review", a, { pull: a.pull_number });
      await gh("POST", `${RP(a)}/pulls/${a.pull_number}/requested_reviewers`, { body: { reviewers: ["copilot-pull-request-reviewer[bot]"] } });
      return "Copilot review requested";
    } },

  { toolset: "pulls", name: "gh_set_pull_draft",
    description: "Convert a PR to draft, or mark it ready for review.",
    shape: { ...R, pull_number: z.number(), draft: z.boolean() },
    async handler(a) {
      write("set_pull_draft", a, { pull: a.pull_number, draft: a.draft });
      const pr = await gh("GET", `${RP(a)}/pulls/${a.pull_number}`);
      if (pr.draft === a.draft) return `Already ${a.draft ? "a draft" : "ready for review"}`;
      const m = a.draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
      await graphql(`mutation($id:ID!){ ${m}(input:{pullRequestId:$id}){ pullRequest{ isDraft } } }`, { id: pr.node_id });
      return a.draft ? "Converted to draft" : "Marked ready for review";
    } },

  { toolset: "pulls", name: "gh_search_pulls",
    description: "Search pull requests only (adds 'is:pr'). Uses GitHub search qualifiers, e.g. 'repo:me/app is:open review-requested:@me'.",
    shape: { query: z.string(), sort: z.enum(["created", "updated", "comments"]).optional(), order: z.enum(["asc", "desc"]).optional(), per_page: z.number().max(100).default(30), page: z.number().default(1) },
    async handler({ query, ...rest }) {
      const d = await gh("GET", "/search/issues", { query: { q: `is:pr ${query}`, ...rest } });
      return { total_count: d.total_count, items: d.items.map((i) => ({ number: i.number, title: i.title, state: i.state, user: i.user.login, repo: i.repository_url.split("/repos/")[1], draft: i.draft, updated_at: i.updated_at, url: i.html_url })) };
    } },

  { toolset: "pulls", name: "gh_list_review_threads",
    description: "Review threads of a PR with resolved/outdated state and thread ids (needed to resolve a thread).",
    shape: { ...R, pull_number: z.number(), first: z.number().default(50) },
    async handler(a) {
      assertRepo(a.owner, a.repo);
      const d = await graphql(`query($o:String!,$r:String!,$n:Int!,$f:Int!){ repository(owner:$o,name:$r){ pullRequest(number:$n){ reviewThreads(first:$f){ nodes{ id isResolved isOutdated path line comments(first:5){ nodes{ author{login} body } } } } } } }`,
        { o: a.owner, r: a.repo, n: a.pull_number, f: a.first });
      return d.repository.pullRequest.reviewThreads.nodes;
    } },

  { toolset: "pulls", name: "gh_set_review_thread_resolved",
    description: "Resolve or unresolve a PR review thread (thread_id from gh_list_review_threads).",
    shape: { thread_id: z.string(), resolved: z.boolean().default(true) },
    async handler({ thread_id, resolved }) {
      guardedGlobalWrite("set_review_thread_resolved", { thread_id, resolved });
      const m = resolved ? "resolveReviewThread" : "unresolveReviewThread";
      await graphql(`mutation($id:ID!){ ${m}(input:{threadId:$id}){ thread{ isResolved } } }`, { id: thread_id });
      return resolved ? "Resolved" : "Unresolved";
    } },

  // ------------------------------------------------------------------ actions
  { toolset: "actions", name: "gh_set_variable",
    description: "Create or update an Actions variable (upsert).",
    shape: { ...R, name: z.string(), value: z.string() },
    async handler(a) {
      write("set_variable", a, { name: a.name });
      try { await gh("PATCH", `${RP(a)}/actions/variables/${encodeURIComponent(a.name)}`, { body: { name: a.name, value: a.value } }); return `Variable ${a.name} updated`; }
      catch (e) { if (status(e) !== 404) throw e; }
      await gh("POST", `${RP(a)}/actions/variables`, { body: { name: a.name, value: a.value } });
      return `Variable ${a.name} created`;
    } },

  { toolset: "actions", name: "gh_get_run_logs_url",
    description: "Short-lived (1 min) download URL of a run's complete log archive (zip).",
    shape: { ...R, run_id: z.number() },
    async handler(a) {
      assertRepo(a.owner, a.repo);
      const r = await gh("GET", `${RP(a)}/actions/runs/${a.run_id}/logs`, { raw: true });
      const url = r.headers.get("location"); if (!url) throw new Error(`No redirect (status ${r.status})`);
      return { url, expires: "about 1 minute" };
    } },

  { toolset: "actions", name: "gh_get_artifact_download_url",
    description: "Short-lived (1 min) download URL of an Actions artifact (zip).",
    shape: { ...R, artifact_id: z.number() },
    async handler(a) {
      assertRepo(a.owner, a.repo);
      const r = await gh("GET", `${RP(a)}/actions/artifacts/${a.artifact_id}/zip`, { raw: true });
      const url = r.headers.get("location"); if (!url) throw new Error(`No redirect (status ${r.status})`);
      return { url, expires: "about 1 minute" };
    } },

  { toolset: "environments", name: "gh_set_environment_secret",
    description: "Create/update an environment secret (encrypted client-side).",
    shape: { ...R, environment_name: z.string(), name: z.string(), value: z.string() },
    async handler(a) {
      write("set_environment_secret", a, { env: a.environment_name, name: a.name });
      const base = `${RP(a)}/environments/${encodeURIComponent(a.environment_name)}`;
      await gh("PUT", `${base}/secrets/${encodeURIComponent(a.name)}`, { body: await sealedSecret(base, a.name, a.value) });
      return `Secret ${a.name} set`;
    } },

  { toolset: "environments", name: "gh_set_dependabot_secret",
    description: "Create/update a Dependabot secret (encrypted client-side).",
    shape: { ...R, name: z.string(), value: z.string() },
    async handler(a) {
      write("set_dependabot_secret", a, { name: a.name });
      const base = `${RP(a)}/dependabot`;
      await gh("PUT", `${base}/secrets/${encodeURIComponent(a.name)}`, { body: await sealedSecret(base, a.name, a.value) });
      return `Secret ${a.name} set`;
    } },

  { toolset: "actions", name: "gh_set_org_actions_secret",
    description: "Create/update an organization Actions secret (encrypted client-side).",
    shape: { org: z.string(), name: z.string(), value: z.string(), visibility: z.enum(["all", "private", "selected"]).default("private"), selected_repository_ids: z.array(z.number()).optional() },
    async handler(a) {
      guardedGlobalWrite("set_org_actions_secret", { org: a.org, name: a.name });
      const base = `/orgs/${encodeURIComponent(a.org)}/actions`;
      await gh("PUT", `${base}/secrets/${encodeURIComponent(a.name)}`, { body: { ...(await sealedSecret(base, a.name, a.value)), visibility: a.visibility, selected_repository_ids: a.selected_repository_ids } });
      return `Org secret ${a.name} set`;
    } },

  // ------------------------------------------------------------------ gists
  { toolset: "gists", name: "gh_create_gist",
    description: "Create a gist. files maps file name -> content.",
    shape: { files: z.record(z.string(), z.string()), description: z.string().optional(), public: z.boolean().default(false) },
    async handler({ files, description, public: pub }) {
      guardedGlobalWrite("create_gist", {});
      const g = await gh("POST", "/gists", { body: { description, public: pub, files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { content: v }])) } });
      return { id: g.id, url: g.html_url, public: g.public };
    } },
  { toolset: "gists", name: "gh_update_gist",
    description: "Edit a gist. files maps name -> new content, or null to delete that file.",
    shape: { gist_id: z.string(), files: z.record(z.string(), z.string().nullable()).optional(), description: z.string().optional() },
    async handler({ gist_id, files, description }) {
      guardedGlobalWrite("update_gist", { gist_id });
      const g = await gh("PATCH", `/gists/${encodeURIComponent(gist_id)}`, { body: { description, files: files && Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v === null ? null : { content: v }])) } });
      return { id: g.id, url: g.html_url };
    } },

  // ------------------------------------------------------------------ graphql + projects + discussions
  { toolset: "graphql", name: "gh_graphql",
    description: "Run any GitHub GraphQL query. Mutations require FULL_CONTROL=true.",
    shape: { query: z.string(), variables: z.record(z.string(), z.any()).optional() },
    async handler({ query, variables }) {
      if (/^\s*(#[^\n]*\n\s*)*mutation\b/i.test(query)) guardedGlobalWrite("graphql_mutation", {});
      return graphql(query, variables);
    } },

  { toolset: "projects", name: "gh_list_projects",
    description: "List Projects (v2) of a user or organization.",
    shape: { owner: z.string(), owner_type: z.enum(["user", "org"]).default("user"), first: z.number().default(30) },
    async handler(a) {
      const f = a.owner_type === "org" ? "organization" : "user";
      const d = await graphql(`query($l:String!,$n:Int!){ ${f}(login:$l){ projectsV2(first:$n){ nodes{ id number title shortDescription closed url updatedAt } } } }`, { l: a.owner, n: a.first });
      return d[f].projectsV2.nodes;
    } },
  { toolset: "projects", name: "gh_get_project",
    description: "A Project (v2): fields (with option/iteration ids) and its first items.",
    shape: { owner: z.string(), owner_type: z.enum(["user", "org"]).default("user"), number: z.number(), items: z.number().default(50) },
    async handler(a) {
      const f = a.owner_type === "org" ? "organization" : "user";
      const d = await graphql(`query($l:String!,$p:Int!,$n:Int!){ ${f}(login:$l){ projectV2(number:$p){ id title url
        fields(first:50){ nodes{ ... on ProjectV2Field{ id name dataType } ... on ProjectV2SingleSelectField{ id name options{ id name } } ... on ProjectV2IterationField{ id name configuration{ iterations{ id title startDate } } } } }
        items(first:$n){ nodes{ id type content{ ... on Issue{ number title state url } ... on PullRequest{ number title state url } ... on DraftIssue{ title } }
          fieldValues(first:20){ nodes{ ... on ProjectV2ItemFieldTextValue{ text field{ ... on ProjectV2FieldCommon{ name } } } ... on ProjectV2ItemFieldSingleSelectValue{ name field{ ... on ProjectV2FieldCommon{ name } } } ... on ProjectV2ItemFieldNumberValue{ number field{ ... on ProjectV2FieldCommon{ name } } } ... on ProjectV2ItemFieldDateValue{ date field{ ... on ProjectV2FieldCommon{ name } } } } } } } } } }`,
        { l: a.owner, p: a.number, n: a.items });
      return d[f].projectV2;
    } },
  { toolset: "projects", name: "gh_add_project_item",
    description: "Add an issue/PR (by node id, from the issue's node_id) or a draft issue to a Project (v2).",
    shape: { project_id: z.string(), content_id: z.string().optional(), draft_title: z.string().optional(), draft_body: z.string().optional() },
    async handler(a) {
      guardedGlobalWrite("add_project_item", { project: a.project_id });
      if (a.content_id) return (await graphql(`mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item{ id } } }`, { p: a.project_id, c: a.content_id })).addProjectV2ItemById.item;
      if (!a.draft_title) throw new Error("Provide content_id or draft_title");
      return (await graphql(`mutation($p:ID!,$t:String!,$b:String){ addProjectV2DraftIssue(input:{projectId:$p,title:$t,body:$b}){ projectItem{ id } } }`, { p: a.project_id, t: a.draft_title, b: a.draft_body })).addProjectV2DraftIssue.projectItem;
    } },
  { toolset: "projects", name: "gh_update_project_item_field",
    description: "Set a field on a Project (v2) item. value is one of {text}, {number}, {date}, {singleSelectOptionId}, {iterationId}.",
    shape: { project_id: z.string(), item_id: z.string(), field_id: z.string(), value: z.record(z.string(), z.any()) },
    async handler(a) {
      guardedGlobalWrite("update_project_item_field", { project: a.project_id });
      return (await graphql(`mutation($p:ID!,$i:ID!,$f:ID!,$v:ProjectV2FieldValue!){ updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:$v}){ projectV2Item{ id } } }`, { p: a.project_id, i: a.item_id, f: a.field_id, v: a.value })).updateProjectV2ItemFieldValue.projectV2Item;
    } },
  { toolset: "projects", name: "gh_delete_project_item",
    description: "Remove an item from a Project (v2). DESTRUCTIVE.",
    shape: { project_id: z.string(), item_id: z.string(), confirm: z.string().optional() },
    async handler(a) {
      guardedGlobalWrite("delete_project_item", { project: a.project_id });
      assertDestructive(a.confirm, a.item_id);
      await graphql(`mutation($p:ID!,$i:ID!){ deleteProjectV2Item(input:{projectId:$p,itemId:$i}){ deletedItemId } }`, { p: a.project_id, i: a.item_id });
      return "Removed";
    } },

  { toolset: "discussions", name: "gh_list_discussion_categories",
    description: "Discussion categories of a repo (ids needed to create a discussion).",
    shape: { ...R },
    async handler(a) {
      assertRepo(a.owner, a.repo);
      return (await graphql(`query($o:String!,$r:String!){ repository(owner:$o,name:$r){ id discussionCategories(first:25){ nodes{ id name emoji isAnswerable } } } }`, { o: a.owner, r: a.repo })).repository;
    } },
  { toolset: "discussions", name: "gh_list_discussions",
    description: "List recent discussions in a repo.",
    shape: { ...R, first: z.number().default(20), category_id: z.string().optional() },
    async handler(a) {
      assertRepo(a.owner, a.repo);
      return (await graphql(`query($o:String!,$r:String!,$n:Int!,$c:ID){ repository(owner:$o,name:$r){ discussions(first:$n,categoryId:$c,orderBy:{field:UPDATED_AT,direction:DESC}){ nodes{ id number title url isAnswered category{ name } author{ login } comments{ totalCount } updatedAt } } } }`,
        { o: a.owner, r: a.repo, n: a.first, c: a.category_id })).repository.discussions.nodes;
    } },
  { toolset: "discussions", name: "gh_get_discussion",
    description: "One discussion with body and comments.",
    shape: { ...R, number: z.number(), comments: z.number().default(30) },
    async handler(a) {
      assertRepo(a.owner, a.repo);
      return (await graphql(`query($o:String!,$r:String!,$n:Int!,$c:Int!){ repository(owner:$o,name:$r){ discussion(number:$n){ id number title body url isAnswered category{ name } author{ login }
        comments(first:$c){ nodes{ id body author{ login } createdAt replies(first:10){ nodes{ id body author{ login } } } } } } } }`, { o: a.owner, r: a.repo, n: a.number, c: a.comments })).repository.discussion;
    } },
  { toolset: "discussions", name: "gh_create_discussion",
    description: "Start a discussion (category by name or id).",
    shape: { ...R, title: z.string(), body: z.string(), category: z.string().describe("category name or id") },
    async handler(a) {
      write("create_discussion", a, { title: a.title });
      const meta = (await graphql(`query($o:String!,$r:String!){ repository(owner:$o,name:$r){ id discussionCategories(first:25){ nodes{ id name } } } }`, { o: a.owner, r: a.repo })).repository;
      const cat = meta.discussionCategories.nodes.find((c) => c.id === a.category || c.name.toLowerCase() === a.category.toLowerCase());
      if (!cat) throw new Error(`Unknown category. Available: ${meta.discussionCategories.nodes.map((c) => c.name).join(", ")}`);
      return (await graphql(`mutation($r:ID!,$c:ID!,$t:String!,$b:String!){ createDiscussion(input:{repositoryId:$r,categoryId:$c,title:$t,body:$b}){ discussion{ id number url } } }`, { r: meta.id, c: cat.id, t: a.title, b: a.body })).createDiscussion.discussion;
    } },
  { toolset: "discussions", name: "gh_add_discussion_comment",
    description: "Comment on a discussion (discussion_id from gh_get_discussion); pass reply_to_id to reply to a comment.",
    shape: { discussion_id: z.string(), body: z.string(), reply_to_id: z.string().optional() },
    async handler(a) {
      guardedGlobalWrite("add_discussion_comment", {});
      return (await graphql(`mutation($d:ID!,$b:String!,$r:ID){ addDiscussionComment(input:{discussionId:$d,body:$b,replyToId:$r}){ comment{ id url } } }`, { d: a.discussion_id, b: a.body, r: a.reply_to_id })).addDiscussionComment.comment;
    } },
];

