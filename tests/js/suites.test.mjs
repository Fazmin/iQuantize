// Validates the built-in prompt suites in src-tauri/resources/suites/*.json.
// Run from the project root: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SUITES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../src-tauri/resources/suites");
const EXPECTED = ["reasoning", "code", "knowledge", "instruction", "multilingual", "summarization", "needle"];
const PROMPT_KEYS = ["category", "system", "prompt", "reference"];
const PLACEHOLDER = "{{haystack}}";

const suites = new Map();
for (const id of EXPECTED) {
  const raw = readFileSync(join(SUITES_DIR, `${id}.json`), "utf8");
  suites.set(id, JSON.parse(raw)); // throws (and fails the run) on invalid JSON
}

const isNonEmptyString = (v) => typeof v === "string" && v.trim() !== "";

test("exactly the expected suite files exist", () => {
  const files = readdirSync(SUITES_DIR).filter((f) => f.endsWith(".json")).sort();
  assert.deepEqual(files, EXPECTED.map((id) => `${id}.json`).sort());
});

test("suite headers are valid and ids match file names", () => {
  for (const [id, suite] of suites) {
    assert.equal(suite.id, id, `${id}.json has id ${suite.id}`);
    assert.ok(isNonEmptyString(suite.name), `${id}: name`);
    assert.ok(isNonEmptyString(suite.description), `${id}: description`);
    assert.ok(Array.isArray(suite.prompts), `${id}: prompts must be an array`);
    const allowed = new Set(["id", "name", "description", "prompts", ...(id === "needle" ? ["haystack"] : [])]);
    for (const key of Object.keys(suite)) assert.ok(allowed.has(key), `${id}: unexpected key ${key}`);
  }
});

test("each suite has 8-12 prompts with the right shape", () => {
  for (const [id, suite] of suites) {
    const n = suite.prompts.length;
    assert.ok(n >= 8 && n <= 12, `${id}: has ${n} prompts`);
    suite.prompts.forEach((p, i) => {
      const where = `${id}.prompts[${i}]`;
      assert.deepEqual(Object.keys(p).sort(), [...PROMPT_KEYS].sort(), `${where}: keys`);
      assert.ok(isNonEmptyString(p.category), `${where}: category`);
      assert.ok(p.system === null || isNonEmptyString(p.system), `${where}: system must be null or a string`);
      assert.ok(isNonEmptyString(p.prompt), `${where}: prompt`);
      assert.ok(p.reference === null || isNonEmptyString(p.reference), `${where}: reference must be null or a string`);
    });
  }
});

test("no duplicate prompts within a suite", () => {
  for (const [id, suite] of suites) {
    const seen = new Set();
    for (const p of suite.prompts) {
      assert.ok(!seen.has(p.prompt), `${id}: duplicate prompt ${p.prompt.slice(0, 60)}`);
      seen.add(p.prompt);
    }
  }
});

test("only the needle suite uses the haystack placeholder", () => {
  for (const [id, suite] of suites) {
    if (id === "needle") continue;
    for (const p of suite.prompts) assert.ok(!p.prompt.includes(PLACEHOLDER), `${id}: unexpected ${PLACEHOLDER}`);
  }
});

test("needle suite: haystack of 1200-1500 words, every prompt uses it and has a reference", () => {
  const needle = suites.get("needle");
  assert.ok(isNonEmptyString(needle.haystack), "haystack must be a string");
  const words = needle.haystack.split(/\s+/).filter(Boolean).length;
  assert.ok(words >= 1200 && words <= 1500, `haystack has ${words} words`);
  assert.ok(!needle.haystack.includes(PLACEHOLDER), "haystack must not contain the placeholder");
  for (const p of needle.prompts) {
    assert.ok(p.prompt.includes(PLACEHOLDER), `needle prompt missing ${PLACEHOLDER}`);
    assert.ok(isNonEmptyString(p.reference), "needle prompts need an exact reference");
    if (p.category === "retrieval") {
      assert.ok(needle.haystack.includes(p.reference), `reference "${p.reference}" not found in haystack`);
    }
  }
});
