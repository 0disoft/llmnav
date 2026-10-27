import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeRust } from "../src/adapters/rust.js";
import { analyzeRustSyntax } from "../src/adapters/rust-syntax.js";

async function fixture(context, source) {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-rust-isolation-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "main.rs");
  await writeFile(file, source);
  return { root, file };
}

test("Rust worker retains syntax results, partial diagnostics and filesystem error codes", async context => {
  const { root, file } = await fixture(context, "pub struct Store { value: i32 }\nimpl Store { fn save(&self, value: i32) -> i32 { value } }\n");
  assert.deepEqual(await analyzeRust(root, [file]), await analyzeRustSyntax(root, [file]));
  await writeFile(file, "fn broken( {\n");
  assert.deepEqual(await analyzeRust(root, [file], { allowErrors: true }), await analyzeRustSyntax(root, [file], { allowErrors: true }));
  await assert.rejects(analyzeRust(root, [file]), /RS_SYNTAX/u);
  await assert.rejects(analyzeRust(root, [path.join(root, "missing.rs")]), { code: "ENOENT" });
});

test("large Rust analysis respects an overall deadline while the caller stays responsive", async context => {
  const { root, file } = await fixture(context, `fn work(){${"0;".repeat(500000)}}`);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  try {
    await assert.rejects(analyzeRust(root, [file], { timeoutMs: 100 }), { code: "LNV102" });
    assert.ok(ticks > 0, "the caller's timers must run during analysis");
  } finally { clearInterval(timer); }
  assert.equal((await analyzeRust(root, [file], { timeoutMs: 30000 })).declarations.length, 2);
});

test("Rust cancellation preserves the caller reason and releases its abort listener", async context => {
  const { root, file } = await fixture(context, `fn work(){${"0;".repeat(500000)}}`);
  const controller = new AbortController(), reason = new Error("cancel Rust analysis");
  const timer = setTimeout(() => controller.abort(reason), 20);
  try {
    await assert.rejects(analyzeRust(root, [file], { signal: controller.signal }), error => error === reason);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    await assert.rejects(analyzeRust(root, [file], { signal: controller.signal }), error => error === reason);
  } finally { clearTimeout(timer); }
});
