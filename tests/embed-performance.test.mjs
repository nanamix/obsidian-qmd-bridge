import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const settingsSource = await readFile(new URL("../src/settings.ts", import.meta.url), "utf8");
const executorSource = await readFile(new URL("../src/qmd-executor.ts", import.meta.url), "utf8");
const mainSource = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");

test("GPU auto mode is the default for embeddings", () => {
  assert.match(settingsSource, /forceCpu:\s*false/);
  assert.match(settingsSource, /embedParallelism:\s*number/);
});

test("embedding execution exposes a bounded parallelism setting", () => {
  assert.match(executorSource, /normalizeEmbedParallelism/);
  assert.match(executorSource, /QMD_EMBED_PARALLELISM/);
  assert.match(executorSource, /args\[0\] === "embed"/);
});

test("legacy CPU default is migrated to GPU auto mode", () => {
  assert.match(settingsSource, /forceCpu:\s*false/);
  assert.match(mainSource, /stored\.forceCpu === true/);
  assert.match(mainSource, /this\.settings\.forceCpu = false/);
});
