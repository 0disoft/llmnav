import assert from "node:assert/strict";
import test from "node:test";
import { createBoundedSelection } from "../src/bounded-selection.js";

test("bounded selection matches stable full sorting without losing ties or duplicates", () => {
  const compare = (left, right) => right.score - left.score || left.group - right.group;
  const repeated = Object.freeze({ score: 6, group: 2 });
  const input = Object.freeze([
    ...Array.from({ length: 20050 }, (_, index) => Object.freeze({ score: (index * 97) % 29, group: index % 7 })),
    repeated, repeated,
  ]);
  const before = [...input];
  for (const top of [1, 2, 3, 5, 100, input.length + 1]) {
    const selection = createBoundedSelection(top, compare);
    let peak = 0;
    for (const value of input) {
      selection.add(value);
      peak = Math.max(peak, selection.size);
    }
    const expected = [...input].sort(compare).slice(0, top);
    assert.deepEqual(selection.values(), expected);
    selection.values().forEach((value, index) => assert.equal(value, expected[index]));
    assert.deepEqual(selection.values(), expected);
    assert.equal(selection.matched, input.length);
    assert.equal(peak, Math.min(top, input.length));
  }
  assert.deepEqual(input, before);
});

test("selection snapshots do not reorder the heap or retain mutations to the output array", () => {
  const selection = createBoundedSelection(3, (left, right) => left - right);
  assert.deepEqual(selection.values(), []);
  assert.equal(selection.matched, 0);
  for (const value of [9, 5, 7]) selection.add(value);
  const snapshot = selection.values();
  assert.deepEqual(snapshot, [5, 7, 9]);
  snapshot.reverse();
  assert.equal(selection.add(8), true);
  assert.equal(selection.add(10), false);
  selection.add(1);
  assert.deepEqual(selection.values(), [1, 5, 7]);
  assert.equal(selection.matched, 6);
});

test("bounded selection rejects invalid capacity and comparator inputs", () => {
  for (const limit of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => createBoundedSelection(limit, () => 0), TypeError);
  }
  assert.throws(() => createBoundedSelection(1, null), TypeError);
});
