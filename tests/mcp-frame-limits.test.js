import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import os from "node:os";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import { createMcpServer, serveMcpStdio } from "../src/mcp.js";
import { MCP_TRANSPORT_LIMITS } from "../src/policy.js";

const LIMIT = MCP_TRANSPORT_LIMITS.maxFrameBytes;
const PING = '{"jsonrpc":"2.0","id":1,"method":"ping"}';

function outputStream() {
  const output = new EventEmitter();
  output.lines = [];
  output.write = line => { output.lines.push(JSON.parse(line)); return true; };
  return output;
}

test("direct MCP lines accept the byte boundary and reject overflow before parsing", async () => {
  const server = createMcpServer({ root: os.tmpdir(), session: null });
  for (const bytes of [LIMIT - 1, LIMIT]) {
    assert.deepEqual((await server.handleLine(PING.padEnd(bytes))).result, {});
  }
  const response = await server.handleLine(PING.padEnd(LIMIT + 1));
  assert.equal(response.error.code, -32600);
  assert.equal(response.id, null);
  assert.match(response.error.message, /input limit/u);
  const unicode = JSON.stringify({ jsonrpc: "2.0", id: "한🙂", method: "ping" });
  assert.equal((await server.handleLine(unicode.padEnd(LIMIT - Buffer.byteLength(unicode) + unicode.length))).id, "한🙂");
  assert.equal((await server.handleLine(unicode.padEnd(LIMIT - Buffer.byteLength(unicode) + unicode.length + 1))).error.code, -32600);
});

test("stdio resets its byte budget for CR, LF and split CRLF and preserves split UTF-8", async () => {
  const unicode = JSON.stringify({ jsonrpc: "2.0", id: "한🙂", method: "ping" });
  const bytes = Buffer.from(unicode + " ".repeat(LIMIT - Buffer.byteLength(unicode)));
  const split = bytes.indexOf(Buffer.from("한")) + 1;
  const input = Readable.from([Buffer.from(PING.padEnd(LIMIT) + "\r"), Buffer.from("\n"),
    bytes.subarray(0, split), bytes.subarray(split), Buffer.from("\n"), Buffer.from(PING + "\r" + PING)]);
  const output = outputStream();
  assert.equal(await serveMcpStdio({ root: os.tmpdir(), input, output, session: null }), 0);
  assert.deepEqual(output.lines.map(line => line.id), [1, "한🙂", 1, 1]);
});

test("each frame gets its own budget even when several arrive in one chunk", async () => {
  const output = outputStream();
  const input = Readable.from([PING.padEnd(LIMIT) + "\n" + PING.padEnd(LIMIT) + "\n"]);
  assert.equal(await serveMcpStdio({ root: os.tmpdir(), input, output, session: null }), 0);
  assert.equal(output.lines.length, 2);
});

for (const phase of ["idle", "tool", "backpressure"]) {
  test(`unterminated oversized input rejects during ${phase} and releases owned resources`, { timeout: 5000 }, async context => {
    const input = new PassThrough(), output = outputStream(), controller = new AbortController();
    const ready = Promise.withResolvers();
    let requestSignal;
    const session = { query: (_task, options) => {
      requestSignal = options.signal;
      ready.resolve();
      return new Promise(() => {});
    } };
    if (phase === "backpressure") output.write = () => { ready.resolve(); return false; };
    const serving = serveMcpStdio({ root: os.tmpdir(), input, output, session, signal: controller.signal, requestTimeoutMs: 0 });
    const observed = serving.catch(error => error);
    context.after(async () => { controller.abort(); input.destroy(); await observed; });
    if (phase === "tool") input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "llmnav_query", arguments: { task: "fixture" } } }) + "\n");
    else if (phase === "backpressure") input.write(PING + "\n");
    else ready.resolve();
    await ready.promise;
    // No line terminator: failure must happen without EOF or a request timer.
    for (let offset = 0; offset < LIMIT; offset += 65536) input.write(Buffer.alloc(65536, 32));
    input.write(" ");
    const error = await observed;
    assert.equal(error.code, "LLMNAV_MCP_FRAME_LIMIT");
    if (requestSignal) {
      assert.equal(requestSignal.aborted, true);
      assert.equal(requestSignal.reason, error);
    }
    assert.equal(input.destroyed, false, "the transport does not own its caller's stream");
    for (const event of ["data", "error"]) assert.equal(input.listenerCount(event), 0, event);
    for (const event of ["drain", "close", "error"]) assert.equal(output.listenerCount(event), 0, event);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });
}
