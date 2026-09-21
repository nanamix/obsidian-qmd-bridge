import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

async function loadExecutor() {
  const tempRoot = await mkdtemp(join(tmpdir(), "qmd-bridge-runtime-"));
  const bundle = join(tempRoot, "qmd-executor.mjs");
  await build({
    entryPoints: [resolve("src/qmd-executor.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    external: ["child_process", "fs", "path", "os"],
    outfile: bundle,
  });
  const { QmdExecutor } = await import(pathToFileURL(bundle).href);
  return { QmdExecutor, tempRoot };
}

test("embed subprocess receives embedding parallelism without leaking it to status", async () => {
  const { QmdExecutor, tempRoot } = await loadExecutor();
  const fakeQmd = join(tempRoot, "fake-qmd.mjs");
  await writeFile(
    fakeQmd,
    '#!/usr/bin/env node\nconsole.log(JSON.stringify({ args: process.argv.slice(2), parallelism: process.env.QMD_EMBED_PARALLELISM ?? null, forceCpu: process.env.QMD_FORCE_CPU ?? null }));\n'
  );
  await chmod(fakeQmd, 0o755);

  const executor = new QmdExecutor(fakeQmd, {}, false, 1, false, "WARN");
  const embedOutput = JSON.parse(await executor.runCommand(["embed"]));
  const statusOutput = JSON.parse(await executor.runCommand(["status"]));

  assert.equal(embedOutput.parallelism, "1");
  assert.equal(embedOutput.forceCpu, null);
  assert.equal(statusOutput.parallelism, null);
});

test("parseJsonResults recovers the JSON array from output mixed with progress logs", async () => {
  const { QmdExecutor } = await loadExecutor();
  const executor = new QmdExecutor("qmd");
  const parse = (out) => executor.parseJsonResults(out).map((r) => r.relativePath);

  const pretty = 'Loading model [1/3]\n[\n  {\n    "docid": "a",\n    "score": 0.5,\n    "file": "qmd://obsidian/a.md"\n  }\n]\nDone in 12ms [ok]\n';
  assert.deepEqual(parse(pretty), ["a.md"]);

  const compact = 'progress 50%\n[{"docid":"b","score":0.1,"file":"qmd://obsidian/b.md","snippet":"x [y] z"}]\n';
  assert.deepEqual(parse(compact), ["b.md"]);

  assert.deepEqual(parse("no json here [nope]"), []);
  assert.deepEqual(parse("[]"), []);
});

test("runCommand aborts the subprocess when the signal fires", async () => {
  const { QmdExecutor, tempRoot } = await loadExecutor();
  const slowQmd = join(tempRoot, "slow-qmd.mjs");
  await writeFile(slowQmd, "#!/usr/bin/env node\nsetTimeout(() => {}, 10000);\n");
  await chmod(slowQmd, 0o755);

  const executor = new QmdExecutor(slowQmd);
  const ac = new AbortController();
  const started = Date.now();
  const pending = executor.runCommand(["search", "x"], { signal: ac.signal });
  setTimeout(() => ac.abort(), 50);

  await assert.rejects(pending, /취소/);
  assert.ok(Date.now() - started < 5000, "abort should not wait for the subprocess to finish");
});

test("runCommand kills the subprocess after timeoutMs", async () => {
  const { QmdExecutor, tempRoot } = await loadExecutor();
  const slowQmd = join(tempRoot, "slow-qmd.mjs");
  await writeFile(slowQmd, "#!/usr/bin/env node\nsetTimeout(() => {}, 10000);\n");
  await chmod(slowQmd, 0o755);

  const executor = new QmdExecutor(slowQmd);
  await assert.rejects(executor.runCommand(["search", "x"], { timeoutMs: 100 }), /끝나지 않아/);
});
