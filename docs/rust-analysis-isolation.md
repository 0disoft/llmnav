# Rust analysis failure isolation

## Reproduced defect

Before 0.19.1, `analyzeRust` performed tokenization and declaration walking synchronously in the caller's Node process. It checked cancellation before each file, but a long parse prevented timer and abort callbacks from running. Its `timeoutMs` option bounded file reads rather than the complete analysis. This could block unrelated requests in a process embedding `analyzeProject`.

On Windows x64 / Node 24.18.0, a 1,000,011-byte input (`fn work(){` + `0;` repeated 500,000 times + `}`) resolved after 692 ms despite a 100 ms deadline. A 10 ms heartbeat fired zero times during that call.

After isolation, the same input and deadline rejected with `LNV102` after 216 ms, including startup, process termination and observed exit. The caller's heartbeat fired 11 times. These are single local observations, not p95/p99 estimates or a guarantee of exact wall-clock completion at the requested timeout.

## Change and compatibility

Keep the existing adapter signature and generator identity. Move the unchanged lexer/declaration algorithm to `rust-syntax.js`, preserving its existing semantic module ID. `rust.js` delegates once per analysis to a Node worker through the existing compiler-process runner. The runner owns its timer, abort listener, output budget, child termination and observed exit.

The worker has a 256 MiB V8 old-space limit and a 32 MiB stdout limit from the runner; native allocations, other V8 spaces and RSS are additional. Default timeout is 120 seconds. Caller abort reasons retain identity, and worker-reported filesystem errors retain their codes. The worker reads source as data and never executes Rust application code.

Tokenization remains O(T) in tokens; this refactor moves that CPU work and O(T) token storage out of the caller rather than reducing total parsing work. It adds one subprocess and one request/result exchange per analysis, not one process per file. The caller still scans source and builds the final graph as before; those phases are outside this Rust-parsing isolation boundary.

A six-declaration fixture took 11 ms in process versus 293 ms through the worker. Both results had SHA-256 `2d50102ed0b89ee8ab9909e1ef27a3a971e5204a772a77cdff83492e35278073` over their compact JSON. The extra startup time buys interruptible parsing and confines parser heap failures to the owned child process.

## Verification

```sh
node --test tests/rust-isolation.test.js tests/additional-languages.test.js tests/compiler-process.test.js
npm run check
npm pack --dry-run --json
```

The focused tests cover unchanged extraction output, partial syntax diagnostics, missing-file error codes, a large input with a deadline, caller heartbeat progress, successful large-input completion, abort-reason identity and listener cleanup. Existing fixtures cover comments, macros, lifetimes, owner binding, graph compatibility, stale publication and CLI/API output equality. Old 0.19.0 metadata benchmarks remain labeled with their original measurement scope.
