import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type MessageStatus = 'received' | 'answered' | 'sent' | 'failed';
export type StoredMessage = { messageId: string; senderId: string; status: MessageStatus; text: string | null; reply: string | null; attempts: number; nextAttemptAt: number };

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sender_id TEXT PRIMARY KEY,
        conversation_id TEXT,
        last_active_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY,
        sender_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('received','answered','sent','failed')),
        text TEXT,
        reply TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `);
    const columns = new Set((this.db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map((c) => c.name));
    if (!columns.has('text')) this.db.exec('ALTER TABLE messages ADD COLUMN text TEXT');
    if (!columns.has('attempts')) this.db.exec('ALTER TABLE messages ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
    if (!columns.has('next_attempt_at')) this.db.exec('ALTER TABLE messages ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0');
  }

  claimMessage(messageId: string, senderId: string, text: string): boolean {
    const now = Date.now();
    const result = this.db.prepare(`INSERT OR IGNORE INTO messages
      (message_id, sender_id, status, text, created_at, updated_at) VALUES (?, ?, 'received', ?, ?, ?)`)
      .run(messageId, senderId, text, now, now);
    return result.changes === 1;
  }

  getMessage(messageId: string): StoredMessage | null {
    return (this.db.prepare(`SELECT message_id AS messageId, sender_id AS senderId, status, text, reply, attempts, next_attempt_at AS nextAttemptAt
      FROM messages WHERE message_id = ?`).get(messageId) as StoredMessage | undefined) ?? null;
  }

  setMessage(messageId: string, status: MessageStatus, reply?: string): void {
    this.db.prepare(`UPDATE messages SET status = ?, reply = COALESCE(?, reply), text = CASE WHEN ? IS NULL THEN text ELSE NULL END, updated_at = ? WHERE message_id = ?`)
      .run(status, reply ?? null, reply ?? null, Date.now(), messageId);
  }

  dueMessages(now = Date.now()): StoredMessage[] {
    return this.db.prepare(`SELECT message_id AS messageId, sender_id AS senderId, status, text, reply, attempts, next_attempt_at AS nextAttemptAt FROM messages WHERE status IN ('received','answered','failed') AND next_attempt_at <= ? ORDER BY created_at`).all(now) as StoredMessage[];
  }

  hasEarlierPending(senderId: string, messageId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM messages AS earlier WHERE earlier.sender_id = ? AND earlier.status <> 'sent' AND earlier.rowid < (SELECT rowid FROM messages WHERE message_id = ?) LIMIT 1`).get(senderId, messageId));
  }

  retry(messageId: string, attempts: number): void {
    const delay = Math.min(300_000, 1000 * 2 ** Math.min(attempts, 8));
    this.db.prepare('UPDATE messages SET status = \'failed\', attempts = ?, next_attempt_at = ?, updated_at = ? WHERE message_id = ?').run(attempts, Date.now() + delay, Date.now(), messageId);
  }

  getSession(senderId: string, timeoutMs: number): string | null {
    const row = this.db.prepare(`SELECT conversation_id AS conversationId, last_active_at AS lastActiveAt
      FROM sessions WHERE sender_id = ?`).get(senderId) as { conversationId: string | null; lastActiveAt: number } | undefined;
    if (!row || Date.now() - row.lastActiveAt > timeoutMs) return null;
    return row.conversationId;
  }

  setSession(senderId: string, conversationId: string | null): void {
    this.db.prepare(`INSERT INTO sessions(sender_id, conversation_id, last_active_at) VALUES (?, ?, ?)
      ON CONFLICT(sender_id) DO UPDATE SET conversation_id = excluded.conversation_id, last_active_at = excluded.last_active_at`)
      .run(senderId, conversationId, Date.now());
  }

  resetSession(senderId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE sender_id = ?').run(senderId);
  }
}
