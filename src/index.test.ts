import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './db.js';
import { normalizeNumber } from './util.js';

test('normalizes international phone numbers', () => {
  assert.equal(normalizeNumber('+61 400-123-456'), '61400123456');
});

test('Store deduplicates and recovers pending messages with retry metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-'));
  const path = join(dir, 'bot.db');
  const first = new Store(path);
  assert.equal(first.claimMessage('m1', '61400', 'hello'), true);
  assert.equal(first.claimMessage('m2', '61400', 'later'), true);
  first.db.prepare('UPDATE messages SET created_at = 1 WHERE message_id IN (?, ?)').run('m1', 'm2');
  assert.equal(first.hasEarlierPending('61400', 'm2'), true);
  assert.equal(first.claimMessage('m1', '61400', 'hello'), false);
  first.retry('m1', 2);
  first.db.close();
  const second = new Store(path);
  const message = second.getMessage('m1');
  assert.equal(message?.text, 'hello');
  assert.equal(message?.attempts, 2);
  assert.equal(message?.status, 'failed');
  second.setMessage('m1', 'answered', 'reply');
  assert.equal(second.getMessage('m1')?.text, null);
  second.setMessage('m1', 'sent');
  assert.equal(second.dueMessages().some((m) => m.messageId === 'm1'), false);
  second.db.close();
  rmSync(dir, { recursive: true, force: true });
});
