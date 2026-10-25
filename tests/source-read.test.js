import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { getEventListeners } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readSourceText } from "../src/util.js";
import { SOURCE_LIMITS } from "../src/policy.js";
import { scanProject } from "../src/project.js";
import { scanProjectIncremental } from "../src/incremental.js";
import { formatProject } from "../src/formatter.js";

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmnav-source-read-"));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("llmnav-source-read-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function resize(file, bytes) {
  const handle = await open(file, "w");
  try { await handle.truncate(bytes); } finally { await handle.close(); }
}

function observeStreams(context, onOpen = () => {}) {
  const streams = [];
  const original = fs.createReadStream;
  const mock = context.mock.method(fs, "createReadStream", (...args) => {
    const stream = original(...args);
    streams.push(stream);
    stream.once("open", () => onOpen(stream, args[0]));
    return stream;
  });
  syncBuiltinESMExports();
  context.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  return streams;
}

test("native source reads accept the byte boundary and close after overflow", async context => {
  const root = await fixture(context), streams = observeStreams(context);
  const file = path.join(root, "source.js"), limit = SOURCE_LIMITS.maxBytes;
  for (const bytes of [0, limit - 1, limit, limit + 1]) {
    await resize(file, bytes);
    if (bytes > limit) await assert.rejects(() => readSourceText(file), /source read limit/u);
    else assert.equal(Buffer.byteLength(await readSourceText(file)), bytes);
    assert.equal(streams.at(-1).closed, true);
    assert.equal(streams.at(-1).bytesRead, Math.min(bytes, limit + 1));
  }
});

test("source reads remain capped when a file grows after opening", async context => {
  const root = await fixture(context), file = path.join(root, "growing.js");
  await writeFile(file, "x");
  const streams = observeStreams(context, (_stream, target) => fs.truncateSync(target, SOURCE_LIMITS.maxBytes * 2));
  await assert.rejects(() => readSourceText(file), /source read limit/u);
  assert.equal(streams[0].bytesRead, SOURCE_LIMITS.maxBytes + 1);
  assert.equal(streams[0].closed, true);
});

test("source decoding preserves Unicode and CRLF across chunk boundaries", async context => {
  const root = await fixture(context), file = path.join(root, "unicode.js");
  const source = `${"x".repeat(SOURCE_LIMITS.readChunkBytes - 1)}한글🙂\r\n`;
  await writeFile(file, source);
  assert.equal(await readSourceText(file), await readFile(file, "utf8"));
  await assert.rejects(() => readSourceText(path.join(root, "missing.js")), { code: "ENOENT" });
});

test("source cancellation preserves its reason and closes the owned file", async context => {
  const root = await fixture(context), file = path.join(root, "cancel.js");
  await resize(file, SOURCE_LIMITS.maxBytes * 2);
  const controller = new AbortController(), reason = new SyntaxError("stop source read");
  const streams = observeStreams(context, stream => stream.once("data", () => controller.abort(reason)));
  await assert.rejects(() => readSourceText(file, { signal: controller.signal }), error => error === reason);
  if (!streams[0].closed) await new Promise(resolve => streams[0].once("close", resolve));
  assert.equal(streams[0].closed, true);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("source I/O hooks keep their signature, UTF-8 limit and original failures", async () => {
  assert.equal(await readSourceText("virtual", { io: { readFile: async (file, encoding, { signal }) => {
    assert.equal(file, "virtual"); assert.equal(encoding, "utf8"); assert.equal(signal.aborted, false);
    return "한글";
  } } }), "한글");
  const oversized = "한".repeat(Math.floor(SOURCE_LIMITS.maxBytes / 3) + 1);
  await assert.rejects(() => readSourceText("virtual", { io: { readFile: async () => oversized } }), /source read limit/u);
  const reason = Object.assign(new Error("read failed"), { code: "EIO" });
  await assert.rejects(() => readSourceText("virtual", { io: { readFile: async () => { throw reason; } } }), error => error === reason);
});

test("full scans, incremental scans and formatting share the native read ceiling", async context => {
  const root = await fixture(context), file = path.join(root, "large.js");
  await resize(file, SOURCE_LIMITS.maxBytes * 2);
  const streams = observeStreams(context);
  for (const scan of [scanProject, scanProjectIncremental, root => formatProject(root, { check: true })]) {
    await assert.rejects(() => scan(root), /source read limit/u);
  }
  assert.equal(streams.length, 3);
  for (const stream of streams) {
    assert.equal(stream.closed, true);
    assert.equal(stream.bytesRead, SOURCE_LIMITS.maxBytes + 1);
  }
  assert.equal((await stat(file)).size, SOURCE_LIMITS.maxBytes * 2);
});
