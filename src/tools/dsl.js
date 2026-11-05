// Tiny declarative DSL so ~200 GitHub endpoints can be described as data.
//
//   [name, "METHOD /path/{owner}/{repo}/x/{id:n}", "description", "params", { options }]
//
// Path variables: {owner} {repo} are strings; {id:n} is a number; {ref*} keeps slashes (branch names, file paths).
// Params (space separated):  q.name?:type  (query string)   b.name:type  (JSON body)   `?` = optional.
// Types: s string, n number, b boolean, sa string[], na number[], o object, oa object[], j any, e(a|b|c) enum.
// Options: destructive (confirm = exact path when FULL_CONTROL=false), pick [keys] (slim the response),
//          listKey (unwrap {total_count, <listKey>: [...]}), accept (custom Accept header, e.g. diff).
import { z } from "zod";
import { gh, wrap, assertRepo, assertWritable, assertDestructive, audit, FULL_CONTROL } from "../core.js";

const SIMPLE = {
  s: () => z.string(), n: () => z.number(), b: () => z.boolean(),
  sa: () => z.array(z.string()), na: () => z.array(z.number()),
  o: () => z.record(z.string(), z.any()), oa: () => z.array(z.record(z.string(), z.any())), j: () => z.any(),
};
export function zodType(t) {
  const m = /^e\((.+)\)$/.exec(t);
  if (m) return z.enum(m[1].split("|"));
  if (!SIMPLE[t]) throw new Error(`Unknown type "${t}"`);
  return SIMPLE[t]();
}

export function parseSpec(toolset, [name, route, description, params = "", opts = {}]) {
  const sp = route.indexOf(" ");
  const method = route.slice(0, sp);
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error(`${name}: bad method`);
  const pathVars = {};
  const pathTpl = route.slice(sp + 1).replace(/\{(\w+)(\*)?(?::(\w+))?\}/g, (_, n, star, t) => {
    pathVars[n] = { star: !!star, type: t || "s" };
    return `{${n}}`;
  });
  const shape = {}, query = [], body = [];
  const add = (key, schema) => {
    if (shape[key]) throw new Error(`${name}: duplicate param "${key}"`);
    shape[key] = schema;
  };
  for (const [n, v] of Object.entries(pathVars)) add(n, zodType(v.type));
  for (const tok of params.split(/\s+/).filter(Boolean)) {
    const m = /^([qb])\.(\w+)(\?)?:(.+)$/.exec(tok);
    if (!m) throw new Error(`${name}: bad param token "${tok}"`);
    const [, where, key, optional, type] = m;
    add(key, optional ? zodType(type).optional() : zodType(type));
    (where === "q" ? query : body).push(key);
  }
  if (method === "GET" && /^gh_(list|search)_/.test(name)) {
    for (const k of ["per_page", "page"]) if (!shape[k]) { add(k, z.number().optional()); query.push(k); }
  }
  if (opts.pick && !shape.full) add("full", z.boolean().optional().describe("Return the full raw response instead of the slim one"));
  if (opts.destructive) add("confirm", z.string().optional().describe("Only needed when FULL_CONTROL=false: the exact request path"));
  const repoScoped = pathTpl.startsWith("/repos/{owner}/{repo}");
  const desc = description + (opts.destructive ? " DESTRUCTIVE." : "");
  return { toolset, name, method, pathTpl, description: desc, shape, query, body, pathVars, repoScoped, opts, params };
}

function pickKeys(obj, keys) {
  if (obj === null || typeof obj !== "object") return obj;
  const out = {};
  for (const k of keys) {
    const parts = k.split(".");
    let v = obj;
    for (const p of parts) v = v == null ? undefined : v[p];
    if (v === undefined) continue;
    let o = out;
    parts.slice(0, -1).forEach((p) => { o = o[p] ??= {}; });
    o[parts.at(-1)] = v;
  }
  return out;
}
const MAX_TEXT = 100_000;

export function makeHandler(spec) {
  const { name, method, pathTpl, pathVars, repoScoped, opts } = spec;
  return wrap(async (args) => {
    if (repoScoped) assertRepo(args.owner, args.repo);
    else if (method !== "GET" && !FULL_CONTROL) throw new Error("Only GET is allowed outside /repos/{owner}/{repo} when FULL_CONTROL=false");
    const path = pathTpl.replace(/\{(\w+)\}/g, (_, n) => {
      const s = String(args[n]);
      return pathVars[n].star ? s.split("/").map(encodeURIComponent).join("/") : encodeURIComponent(s);
    });
    if (method !== "GET") { assertWritable(); audit(name, { path }); }
    if (opts.destructive) assertDestructive(args.confirm, path);
    const query = {};
    for (const k of spec.query) if (args[k] !== undefined) query[k] = Array.isArray(args[k]) ? args[k].join(",") : args[k];
    let body;
    if (method !== "GET" && spec.body.length) {
      body = {};
      for (const k of spec.body) if (args[k] !== undefined) body[k] = args[k];
    }
    let data = await gh(method, path, { query, body, headers: opts.accept ? { Accept: opts.accept } : undefined });
    if (opts.listKey && data && !Array.isArray(data) && Array.isArray(data[opts.listKey])) {
      data = data.total_count !== undefined ? { total_count: data.total_count, items: data[opts.listKey] } : data[opts.listKey];
    }
    if (opts.pick && !args.full) {
      const slim = (x) => pickKeys(x, opts.pick);
      if (Array.isArray(data)) data = data.map(slim);
      else if (data && Array.isArray(data.items)) data = { ...data, items: data.items.map(slim) };
      else data = slim(data);
    }
    if (typeof data === "string" && data.length > MAX_TEXT) data = data.slice(0, MAX_TEXT) + `\n…[truncated, ${data.length} chars total]`;
    return data;
  });
}

export function registerSpec(s, spec) {
  s.tool(spec.name, spec.description, spec.shape, spec.handler ||= makeHandler(spec));
}
