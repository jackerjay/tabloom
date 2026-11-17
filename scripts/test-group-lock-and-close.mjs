#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, tab } from './lifecycle-fixture.mjs';

const DAY = 86400000;

test('group lock persists in storage.local and rejects missing group IDs when locking', async () => {
  const f = fixture(
    [tab(1, { groupId: 10 }), tab(2, { groupId: 10 })],
    [{ id: 10, windowId: 1, title: '核心工作', color: 'blue', collapsed: false }],
  );
  const missing = await f.send({ type: 'group-lock-set', groupId: 999, locked: true });
  assert.equal(missing.ok, false);

  const locked = await f.send({ type: 'group-lock-set', groupId: 10, locked: true });
  assert.equal(locked.ok, true);
  assert.equal(locked.locked, true);
  assert.deepEqual(locked.lockedGroupIds, [10]);
  assert.deepEqual(f.stores.local.lockedGroupIds, [10]);

  const unlocked = await f.send({ type: 'group-lock-set', groupId: 10, locked: false });
  assert.equal(unlocked.ok, true);
  assert.equal(unlocked.locked, false);
  assert.deepEqual(unlocked.lockedGroupIds, []);
});

test('locked group tabs are shielded from cleanupAdvice, cleanupClose, dedup, organize, and auto-discard alarm', async () => {
  const f = fixture([], [
    { id: 10, windowId: 1, title: 'Locked Group', color: 'blue', collapsed: false },
    { id: 20, windowId: 1, title: 'Unlocked Group', color: 'green', collapsed: false },
  ]);
  const now = f.now();
  [
    tab(1, { groupId: 10, url: 'https://dup.example/doc', lastAccessed: now - 15 * DAY }),
    tab(2, { groupId: 10, url: 'https://locked-idle.example/', lastAccessed: now - 20 * DAY }),
    tab(3, { groupId: 20, url: 'https://dup.example/doc', lastAccessed: now - 12 * DAY }),
    tab(4, { groupId: 20, url: 'https://unlocked-idle.example/', lastAccessed: now - 12 * DAY }),
  ].forEach(t => f.tabs.set(t.id, t));

  await f.send({ type: 'group-lock-set', groupId: 10, locked: true });

  // 1) cleanup-advice skips locked group tabs
  const advice = await f.send({ type: 'cleanup-advice', windowId: 1 });
  assert.equal(advice.ok, true);
  assert.deepEqual(advice.candidates.map(c => c.id).sort((a, b) => a - b), [3, 4]);

  // 2) cleanup-close skips explicitly supplied locked tab IDs
  const cleanup = await f.send({ type: 'cleanup-close', windowId: 1, tabIds: [2, 4] });
  assert.equal(cleanup.ok, true);
  assert.equal(cleanup.closed, 1);
  assert.equal(cleanup.skippedLocked, 1);
  assert.equal(f.tabs.has(2), true);
  assert.equal(f.tabs.has(4), false);

  // 3) dedup keeps locked tab and closes unlocked duplicate only
  const dupCount = await f.send({ type: 'dup-count', windowId: 1 });
  assert.equal(dupCount.count, 1);
  const dedupRes = await f.send({ type: 'dedup', windowId: 1 });
  assert.equal(dedupRes.closed, 1);
  assert.equal(f.tabs.has(1), true);
  assert.equal(f.tabs.has(3), false);

  // 4) organize excludes tabs inside locked groups completely
  f.tabs.set(5, tab(5, { groupId: -1, url: 'https://new-ungrouped.example/', lastAccessed: now }));
  f.hooks.fetchResult = { source: 'ai', groups: [{ name: 'Inbox', color: 'cyan', tabIds: [5] }] };
  const orgRes = await f.send({ type: 'organize', windowId: 1, apply: true });
  assert.equal(orgRes.ok, true);
  const body = JSON.parse(f.calls.fetch[0].body);
  assert.deepEqual(body.tabs.map(t => t.id), [5]);
});

test('quick close option 1 preserves group for reopening while option 2 disbands permanently when unlocked', async () => {
  const f = fixture([], [
    { id: 10, windowId: 1, title: 'Keepable Group', color: 'blue', collapsed: false },
    { id: 20, windowId: 1, title: 'Disposable Group', color: 'red', collapsed: false },
  ]);
  [
    tab(1, { groupId: 10, url: 'https://keep.example/1', title: 'Keep 1' }),
    tab(2, { groupId: 10, url: 'https://keep.example/2', title: 'Keep 2' }),
    tab(3, { groupId: 20, url: 'https://drop.example/1', title: 'Drop 1' }),
    tab(4, { groupId: 20, url: 'https://drop.example/2', title: 'Drop 2' }),
  ].forEach(t => f.tabs.set(t.id, t));

  // Locked group cannot be force-closed
  await f.send({ type: 'group-lock-set', groupId: 20, locked: true });
  const blockedForce = await f.send({ type: 'group-force-close', groupId: 20, windowId: 1 });
  assert.equal(blockedForce.ok, false);
  assert.equal(f.tabs.has(3), true);
  assert.equal(f.tabs.has(4), true);

  // Option 1: Save & Close -> recoverable via archive restore
  const savedClose = await f.send({ type: 'group-archive-close', groupIds: [10], windowId: 1 });
  assert.equal(savedClose.ok, true);
  assert.equal(savedClose.closedTabs, 2);
  assert.equal(f.tabs.has(1), false);
  assert.equal(f.tabs.has(2), false);
  const archivesBeforeForce = await f.send({ type: 'group-archive-list' });
  assert.equal(archivesBeforeForce.archives.length, 1);

  // Unlock -> Option 2: Disband & permanently close without archiving
  await f.send({ type: 'group-lock-set', groupId: 20, locked: false });
  const forceClose = await f.send({ type: 'group-force-close', groupId: 20, windowId: 1 });
  assert.equal(forceClose.ok, true);
  assert.equal(forceClose.closedTabs, 2);
  assert.equal(f.tabs.has(3), false);
  assert.equal(f.tabs.has(4), false);
  assert.equal(f.groups.has(20), false);
  const archivesAfterForce = await f.send({ type: 'group-archive-list' });
  assert.equal(archivesAfterForce.archives.length, 1);

  // Option 1 group can be reopened intact
  const restored = await f.send({ type: 'group-archive-restore', id: savedClose.id, targetWindowId: 1 });
  assert.equal(restored.ok, true);
  assert.equal(restored.restoredTabs, 2);
  assert.equal(restored.restoredGroups, 1);
});

test('manual group rename updates Chrome group, persists record, and blocks automatic or full AI overwrite', async () => {
  const f = fixture(
    [
      tab(1, { groupId: 10, url: 'https://work.example/a' }),
      tab(2, { groupId: 10, url: 'https://work.example/b' }),
      tab(3, { groupId: -1, url: 'https://work.example/c' }),
    ],
    [{ id: 10, windowId: 1, title: 'Old AI Group', color: 'grey', collapsed: false }],
  );

  // Rename group 10 manually
  const ren = await f.send({ type: 'group-rename', groupId: 10, title: '核心上线清单' });
  assert.equal(ren.ok, true);
  assert.equal(ren.title, '核心上线清单');
  assert.equal(f.groups.get(10).title, '核心上线清单');
  assert.equal(f.stores.local.manualNamedGroups['10'], '核心上线清单');

  // 1) Incremental organize excludes tabs inside manually-named group 10 while still passing its name in existingGroups
  f.hooks.fetchResult = { source: 'ai', groups: [{ name: '核心上线清单', color: 'blue', tabIds: [3] }] };
  const inc = await f.send({ type: 'organize', windowId: 1, incremental: true, apply: true });
  assert.equal(inc.ok, true);
  const incPayload = JSON.parse(f.calls.fetch[0].body);
  assert.deepEqual(incPayload.tabs.map(t => t.id), [3]);
  assert.ok(incPayload.existingGroups.includes('核心上线清单'));
  assert.equal(f.groups.get(10).title, '核心上线清单');

  // 2) Full organize proposing a different AI name for those tabs MUST NOT overwrite manually pinned name!
  f.hooks.fetchResult = { source: 'ai', groups: [{ name: 'AI猜的新名字', color: 'green', tabIds: [1, 2, 3] }] };
  const full = await f.send({ type: 'organize', windowId: 1, incremental: false, apply: true });
  assert.equal(full.ok, true);
  assert.equal(f.groups.get(10).title, '核心上线清单');
  assert.equal(f.tabs.get(3).groupId, 10);
});
