// Schema test for the user guide (src/js/help/*.js): article shape, block types,
// and that every cross-link points at something that exists.
// Run from the project root: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CHAPTERS, ROUTE_ARTICLE } from "../../src/js/help/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "../../src");

const chapters = await Promise.all(CHAPTERS.map(async (c) => ({ ...c, articles: (await import(`../../src/js/help/${c.file}.js`)).default })));
const articles = chapters.flatMap((c) => c.articles.map((a) => ({ ...a, chapter: c.id })));
const ids = new Set(articles.map((a) => a.id));

const kbIds = new Set();
for (const f of fs.readdirSync(path.join(src, "js/kb"))) {
  if (f === "index.js" || !f.endsWith(".js")) continue;
  for (const id of Object.keys((await import(`../../src/js/kb/${f}`)).default)) kbIds.add(id);
}

const mainJs = fs.readFileSync(path.join(src, "js/main.js"), "utf8");
const ROUTES = [...mainJs.matchAll(/define\('([^']+)', '([^']+)'/g)].map((m) => ({ pattern: m[1], name: m[2] }));
const routeRe = (p) => new RegExp(`^${p.replace(/:[a-z_]+/gi, "[^/]+")}$`);

const ARTICLE_KEYS = new Set(["id", "title", "summary", "body", "terms"]);
const BLOCK_TYPES = new Set(["p", "h", "h3", "list", "steps", "defs", "table", "keys", "action", "tip", "note", "warn"]);
const HTML_TAG = /<\/?[a-z][a-z0-9-]*(\s[^>]*)?>/i;
const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

function strings(block) {
  const [type, v] = Object.entries(block)[0];
  if (typeof v === "string") return [v];
  if (type === "list") return v;
  if (type === "steps") return v.flatMap((s) => (typeof s === "string" ? [s] : [s.title, s.text || ""]));
  if (type === "defs") return v.flat();
  if (type === "table") return [...v.head, ...v.rows.flat()];
  if (type === "keys") return v.map(([, label]) => label);
  if (type === "action") return [v.label];
  return [];
}

test("every chapter has articles and ids are unique and prefixed by chapter", () => {
  for (const c of chapters) assert.ok(c.articles.length > 0, `chapter ${c.id} is empty`);
  assert.equal(ids.size, articles.length, "duplicate article id");
  for (const a of articles) assert.ok(a.id.startsWith(`${a.chapter}.`), `${a.id} should start with "${a.chapter}."`);
});

test("articles have the expected shape", () => {
  for (const a of articles) {
    for (const k of Object.keys(a)) if (k !== "chapter") assert.ok(ARTICLE_KEYS.has(k), `${a.id}: unknown key ${k}`);
    assert.ok(a.title?.length > 3, `${a.id}: title`);
    assert.ok(a.summary?.length > 20, `${a.id}: summary`);
    assert.ok(Array.isArray(a.body) && a.body.length >= 3, `${a.id}: body needs at least 3 blocks`);
    for (const b of a.body) {
      const keys = Object.keys(b);
      assert.equal(keys.length, 1, `${a.id}: a block has ${keys.length} keys`);
      assert.ok(BLOCK_TYPES.has(keys[0]), `${a.id}: unknown block type ${keys[0]}`);
      // Placeholders such as `<model>` are fine inside code spans; prose must not look like HTML.
      for (const s of strings(b)) assert.ok(!HTML_TAG.test(s.replace(/`[^`]*`/g, '')), `${a.id}: HTML in text: ${s}`);
    }
    for (const t of a.terms || []) assert.ok(kbIds.has(t), `${a.id}: unknown term ${t}`);
  }
});

test("links point at real articles, KB entries and routes", () => {
  const check = (a, target) => {
    if (target.startsWith("help:")) assert.ok(ids.has(target.slice(5)), `${a.id}: broken help link ${target}`);
    else if (target.startsWith("term:")) assert.ok(kbIds.has(target.slice(5)), `${a.id}: broken term link ${target}`);
    else if (target.startsWith("#/")) {
      const p = target.slice(1).split("?")[0];
      assert.ok(ROUTES.some((r) => routeRe(r.pattern).test(p)), `${a.id}: unknown route ${target}`);
    } else assert.ok(target.startsWith("https://"), `${a.id}: unsupported link ${target}`);
  };
  for (const a of articles) {
    for (const b of a.body) {
      for (const s of [...strings(b), a.summary]) for (const m of s.matchAll(LINK)) check(a, m[2]);
      if (b.action) check(a, b.action.go);
    }
  }
});

test("every page has a contextual help article", () => {
  for (const name of new Set(ROUTES.map((r) => r.name))) {
    if (name === "help") continue;
    assert.ok(ROUTE_ARTICLE[name], `no help article mapped for route "${name}"`);
  }
  for (const [name, id] of Object.entries(ROUTE_ARTICLE)) assert.ok(ids.has(id), `ROUTE_ARTICLE.${name} -> missing ${id}`);
});
