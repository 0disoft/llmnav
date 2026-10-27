/** Keep the best values in stable encounter order; retained values must stay immutable. */
export function createBoundedSelection(limit, compare) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError("Selection limit must be a positive integer.");
  if (typeof compare !== "function") throw new TypeError("Selection comparator must be a function.");
  const heap = [];
  let matched = 0;
  const compareEntries = (left, right) => compare(left.value, right.value) || left.order - right.order;
  return {
    get matched() { return matched; },
    get size() { return heap.length; },
    add(value) {
      const order = matched++;
      // An equal later value loses the stable tie, so rejected values need no entry.
      if (heap.length === limit && compare(value, heap[0].value) >= 0) return false;
      const entry = { value, order };
      if (heap.length < limit) {
        heap.push(entry);
        siftUp(heap, entry, compareEntries);
      } else {
        siftDown(heap, entry, compareEntries);
      }
      return true;
    },
    values() { return [...heap].sort(compareEntries).map(entry => entry.value); },
  };
}

// The worst retained entry stays at the root, ready for constant-time rejection.
function siftUp(heap, entry, compare) {
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compare(heap[parent], entry) >= 0) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = entry;
}

function siftDown(heap, entry, compare) {
  let index = 0;
  for (let child = 1; child < heap.length; child = index * 2 + 1) {
    if (child + 1 < heap.length && compare(heap[child + 1], heap[child]) > 0) child++;
    if (compare(entry, heap[child]) >= 0) break;
    heap[index] = heap[child];
    index = child;
  }
  heap[index] = entry;
}
