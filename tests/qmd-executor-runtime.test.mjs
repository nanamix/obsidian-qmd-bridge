import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

test("embed subprocess receives embedding parallelism without leaking it to status", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "qmd-bridge-runtime-"));
  const fakeQmd = join(tempRoot, "fake-qmd.mjs");
  const bundle = join(tempRoot, "qmd-executor.mjs");

  await writeFile(
    fakeQmd,
    '#!/usr/bin/env node\nconsole.log(JSON.stringify({ args: process.argv.slice(2), parallelism: process.env.QMD_EMBED_PARALLELISM ?? null, forceCpu: process.env.QMD_FORCE_CPU ?? null }));\n'
  );
  await chmod(fakeQmd, 0o755);
  await build({
    entryPoints: [resolve("src/qmd-executor.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    external: ["child_process", "fs", "path", "os"],
    outfile: bundle,
  });

  const { QmdExecutor } = await import(pathToFileURL(bundle).href);
  const executor = new QmdExecutor(fakeQmd, {}, false, 1, false, "WARN");
  const embedOutput = JSON.parse(await executor.runCommand(["embed"]));
  const statusOutput = JSON.parse(await executor.runCommand(["status"]));

  assert.equal(embedOutput.parallelism, "1");
  assert.equal(embedOutput.forceCpu, null);
  assert.equal(statusOutput.parallelism, null);
});
