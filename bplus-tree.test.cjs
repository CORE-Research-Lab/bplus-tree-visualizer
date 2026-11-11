const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { runInThisContext } = require('node:vm');

// Exercise the same engine and presets that the standalone page loads.
const page = readFileSync(join(__dirname, 'index.html'), 'utf8');
const engineScript = page.match(/<script>([\s\S]*?)<\/script>/)[1];
const { E, SCENARIOS } = runInThisContext(`(() => { ${engineScript}; return { E, SCENARIOS }; })()`);

function run(tree, type, key) {
  const steps = [];
  E.run(tree, { type, key }, steps);
  assert.deepEqual(E.check(tree), []);
  assert.deepEqual(steps.at(-1).tree, tree);
  return steps;
}

function phases(steps) {
  const ids = steps.map(step => step.algo[0]);
  return ids.filter((id, i) => id !== ids[i - 1]);
}

test('search follows equal separators right and scans only the destination leaf', () => {
  const tree = E.make(4, { k: [10], c: [[1, 2], [10, 14, 19]] });
  const before = E.clone(tree);
  const leafId = tree.root.children[1].id;
  for (const [key, scanned, found] of [
    [10, [10], true], [19, [10, 14, 19], true],
    [12, [10, 14], false], [20, [10, 14, 19], false]
  ]) {
    const [route, ...scan] = run(tree, 'search', key);
    assert.deepEqual(route.hl.edges, { [tree.root.id]: 1 });
    assert.deepEqual(route.hl.keys, { [tree.root.id]: { 10: 'probe' } });
    assert.deepEqual(scan.map(step => step.hl.keys), scanned.map(entry => ({ [leafId]: { [entry]: 'probe' } })));
    for (const step of scan) assert.deepEqual(step.hl.edges, route.hl.edges);
    assert.equal(scan.at(-1).title, found ? `Found ${key}*` : `${key}* is not in the tree`);
    assert.deepEqual(tree, before);
  }
  const empty = run(E.make(4, []), 'search', 0);
  assert.equal(empty.length, 1);
  assert.equal(empty[0].text, 'The root leaf is empty.');
});

test('a full parent splits after a leaf split, copying then promoting', () => {
  const tree = E.make(2, { k: [3, 5], c: [[1, 2], [3, 4], [5, 6]] });
  const steps = run(tree, 'insert', 7);
  assert.deepEqual(phases(steps), ['ins-1', 'ins-3', 'ins-4']);
  assert.deepEqual(tree.root.keys, [5]);
  assert.deepEqual(tree.root.children.map(n => n.keys), [[3], [6]]);
  assert.deepEqual(E.leaves(tree).map(n => n.keys), [[1, 2], [3, 4], [5], [6, 7]]);
});

test('exactly half full keeps the leaf and its valid routing boundary', () => {
  const tree = E.make(4, { k: [10], c: [[1, 2], [10, 11, 12]] });
  assert.deepEqual(phases(run(tree, 'delete', 10)), ['del-1', 'del-2']);
  assert.deepEqual(tree.root.keys, [10]);
  assert.equal(run(tree, 'search', 10).at(-1).title, '10* is not in the tree');
  run(tree, 'insert', 10);
  assert.deepEqual(tree.root.children[1].keys, [10, 11, 12]);
});

test('check adjacent leaves left first, then right if needed, before merging', () => {
  for (const leftCanLend of [true, false]) {
    const left = leftCanLend ? [1, 2, 3] : [1, 2];
    const tree = E.make(4, { k: [10, 20], c: [left, [10, 11], [20, 21, 22]] });
    const steps = run(tree, 'delete', 11);
    const checks = steps.filter(s => s.title.startsWith('Can the ')).map(s => s.title);
    assert.deepEqual(checks, leftCanLend ? ['Can the left sibling lend?'] : ['Can the left sibling lend?', 'Can the right sibling lend?']);
    assert.deepEqual(tree.root.keys, leftCanLend ? [3, 20] : [10, 21]);
    assert.deepEqual(tree.root.children[1].keys, leftCanLend ? [3, 10] : [10, 20]);
    assert.equal(steps.at(-1).algo[0], 'del-3');
  }
});

test('after a leaf merge, the underfull index borrows a subtree through its parent', () => {
  for (const donorOnLeft of [true, false]) {
    const left = donorOnLeft ? { k: [3, 5], c: [[1], [3], [5]] } : { k: [3], c: [[1], [3]] };
    const right = donorOnLeft ? { k: [9], c: [[7], [9]] } : { k: [9, 11], c: [[7], [9], [11]] };
    const tree = E.make(2, { k: [7], c: [left, right] });
    const steps = run(tree, 'delete', donorOnLeft ? 9 : 1);
    assert.deepEqual(phases(steps), ['del-1', 'del-2', 'del-3', 'del-4', 'del-5', 'del-3']);
    assert.deepEqual(tree.root.keys, donorOnLeft ? [5] : [9]);
    assert.deepEqual(tree.root.children.map(n => n.keys), donorOnLeft ? [[3], [7]] : [[7], [11]]);
    assert.deepEqual(tree.root.children.map(n => n.children.map(c => c.keys)), donorOnLeft ? [[[1], [3]], [[5], [7]]] : [[[3], [7]], [[9], [11]]]);
  }
});

test('merge through the root, promote its child and eventually empty the root leaf', () => {
  const tree = E.make(2, { k: [5], c: [{ k: [3], c: [[1], [3]] }, { k: [7], c: [[5], [7]] }] });
  const steps = run(tree, 'delete', 3);
  assert.deepEqual(phases(steps), ['del-1', 'del-2', 'del-3', 'del-4', 'del-5', 'del-3', 'del-4', 'del-5']);
  assert.deepEqual(tree.root.keys, [5, 7]);
  for (const k of [1, 5, 7]) run(tree, 'delete', k);
  assert.equal(tree.root.leaf, true);
  assert.deepEqual(tree.root.keys, []);
});

test('every preset and seeded sequences preserve the reference set and tree invariants', () => {
  function exercise(tree, ops) {
    const expected = new Set(E.leaves(tree).flatMap(n => n.keys));
    for (const [type, key] of ops) {
      const steps = run(tree, type, key);
      if (type === 'insert') expected.add(key);
      if (type === 'delete') expected.delete(key);
      if (type === 'search') assert.equal(steps.at(-1).title.startsWith('Found'), expected.has(key));
      assert.deepEqual(E.leaves(tree).flatMap(n => n.keys), [...expected].sort((a, b) => a - b));
    }
  }
  for (const sc of SCENARIOS) exercise(E.make(sc.cap, sc.tree), sc.ops);
  let seed = 173;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (const cap of [2, 4]) {
    const ops = Array.from({ length: 1500 }, () => [['insert', 'delete', 'search'][next() % 3], next() % 97]);
    exercise(E.make(cap, []), ops);
  }
});
