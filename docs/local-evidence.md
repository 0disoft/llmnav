# Local provenance and verification

## File history

```sh
llmnav history src/analysis.js --json
```

API: `getFileHistory(root, file, { signal, timeoutMs, gitCommand })`; MCP: `llmnav_history` with `{ file }`. Use a path from `show` or `discover`. The operation has no default-navigation cost and writes no Git state or generated artifact.

`lastChange` names the last file commit and committer date, with `scope: "file"`. `dirty` separates staged, unstaged and untracked changes. Index and working-file byte fingerprints refresh even when HEAD is unchanged. Missing/deleted working files have a null hash. Unborn repositories have no HEAD or last change; non-Git folders return `unknown`. Missing tools, permissions, cancellation and process failures propagate rather than becoming an empty history.

History lookup pins `git log --follow` to the observed HEAD. Its bounded in-memory cache keys repository, revision, path and shallow state; volatile status and worktree hashes are never cached. Shallow repositories report incomplete history. Rename handling follows Git's heuristic. Reads are best-effort observations rather than an atomic Git/worktree transaction, and `symbolHistory` remains `unknown`. File dates do not establish when a particular function changed, whether tests passed, or whether performance improved.

Git runs with literal pathspecs, disabled filesystem-monitor hooks, no optional locks, bounded output, a default 10-second deadline and cancellation. File fingerprints reject path traversal and symlink/junction traversal, bound each file to 64 MiB and close owned handles on failure.

## Verification receipts

Capture inputs **before** running a check. Run the command through your existing test runner, then submit the outcome and evidence file paths. LLMNav does not execute the command or certify a caller's claim. It hashes evidence, retains command arguments and source/environment identity, and labels the provenance `caller-reported`.

```js
import { captureVerificationSnapshot, recordVerification, getVerification } from "llmnav";
const snapshot = await captureVerificationSnapshot(root, ["src/service.ts", "tests/service.test.ts", "package-lock.json"]);
// Run the check in your existing harness and retain its exit result and log.
const recorded = await recordVerification(root, {
  snapshot, command: ["node", "--test", "tests/service.test.ts"],
  outcome: "passed", evidence: ["test-results/service.log"],
});
const current = await getVerification(root, recorded.id);
```

The example's outcome is a placeholder for the harness result. The library never infers success from a command name. Do not include credentials in argv or optional context fields; process environment variables and log contents are not copied into the receipt.

CLI equivalents:

```sh
llmnav snapshot src/service.ts tests/service.test.ts package-lock.json --output .llmnav/local/snapshot.json --json
# Compose a manifest with the snapshot object, command argv, outcome and evidence paths.
llmnav record-verification --file .llmnav/local/manifest.json --json
llmnav verification <receipt-id> --json
llmnav verification <receipt-id> --details --metadata-budget 4000 --json
```

The default summary separates `outcome` from `sourceMatch`, `environmentMatch`, `evidenceMatch`, and `applicability`. MCP exposes read-only lookup as `llmnav_verification`; receipt capture/import is a local API/CLI operation. Detail responses respect a compact UTF-8 JSON budget of 512–64,000 bytes. Oversized details return `detailsOmitted` and `requiredBytes` instead of silently clipping a signature or manifest. Missing receipts return unknown; malformed IDs, tampering, permission failures and cancellation are errors.

Snapshots contain 1–1,000 explicit regular files. Include source, tests, configuration, manifests and lockfiles needed by the check. Adding an unlisted file is outside that scope and cannot be detected by comparing its hashes. Default `completeInputs: false` therefore keeps applicability unknown even when listed files match. Set `completeInputs: true` (CLI: `--complete-inputs`) only when the caller can attest that these are all relevant inputs. Optional string `context` records external tool/dependency identities; lookup must supply it to assess that context. Environment matching also checks Node version, platform and architecture. Matching inputs describes applicability to the caller's declared snapshot, not independently established correctness or function coverage.

A source change before recording is retained as stale even if that file is later reverted. Changed/deleted evidence or source files and known environment/context changes are stale. Missing external context or evidence leaves applicability unknown. Input capture and runner execution are caller-managed, not an immutable filesystem transaction; a change followed by a revert during the check is not observable from endpoint hashes alone.

Receipts live under ignored `.llmnav/local/verifications/<sha256>.json`, outside generated indexes. Atomic content-addressed publication prevents concurrent distinct records from overwriting each other. Reads check exact file integrity before interpreting the receipt. The store has no automatic pruning: retain or remove local receipts according to your project's evidence policy. A repository-wide test pass must never become a per-function verification claim or a performance-improvement claim.
