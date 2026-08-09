# LLMNav v0.2 performance report

This report contains measured results from `npm run benchmark:v0.2`. It is not an estimate. The raw record is `benchmarks/results/v0.2-win32-x64-node24.json`.

## Environment

| Property | Value |
| --- | --- |
| Platform | win32 x64 |
| Node.js | v24.18.0 |
| CPU | AMD Ryzen 5 7430U with Radeon Graphics          |
| Logical CPUs | 12 |
| Fixture | 1,000 files, 5,000 cards |
| Filesystem cache | Not flushed |

## Generation

| Scenario | Time | Parsed files | Reused files | Retokenized cards |
| --- | ---: | ---: | ---: | ---: |
| Cold initial generation | 7190.90 ms | 1000 | 0 | 5000 |
| One-file incremental regeneration | 4901.54 ms | 1 | 999 | 1 |
| Same change, forced full regeneration | 7450.25 ms | 1000 | 0 | 5000 |
| No-op incremental regeneration | 2209.92 ms | 0 | 1000 | 0 |

The one-file incremental run was 1.52× faster than the forced full run on this machine. Incremental and full generation produced byte-identical cache trees across 507 files (33.25 MiB).

## Fresh-process query

Each sample started a fresh Node.js process and included reading and parsing the required generated JSON. The operating-system filesystem cache was not flushed.

| Search path | Correct runs | Median | p95 | Median RSS | Input artifacts |
| --- | ---: | ---: | ---: | ---: | ---: |
| v0.1-compatible legacy retokenization | 7/7 | 394.47 ms | 429.81 ms | 146.52 MiB | 4.78 MiB index |
| v0.2 deterministic inverted index | 7/7 | 221.11 ms | 253.12 ms | 118.12 MiB | 16.22 MiB index + search index |

The v0.2 median was 1.78× faster. Both paths returned the same result checksum, and all runs returned the expected semantic ID.

## Interpretation

The query comparison deliberately includes JSON loading. It therefore measures the cost seen by a one-shot CLI process rather than only the in-memory ranking loop. The generation comparison uses two copies of the same fixture and verifies the resulting cache bytes before reporting the timing.

The changed source file contains five cards, so the machine-readable body-hash diff reports five modified cards. Only one card changed searchable fields, and the card-level inverted index retokenized exactly that one card.
