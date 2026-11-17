import { DatabaseSync } from 'node:sqlite';
import { validateData } from './contract.mjs';
export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS samples(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS samples_at ON samples(at);
      CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, at INTEGER NOT NULL, body TEXT NOT NULL, ack TEXT);
      CREATE INDEX IF NOT EXISTS commands_at ON commands(at);`);
    this.db.prepare('UPDATE commands SET ack=? WHERE ack IS NULL').run(JSON.stringify({ accepted: false, applied: false, reason: 'SERVER_RESTARTED' }));
    this.lastPruned = 0;
  }
  sample(body, at = Date.now()) {
    this.db.prepare('INSERT INTO samples(at,body) VALUES(?,?)').run(at, JSON.stringify(body));
    if (at - this.lastPruned > 3600000) {
      this.db.prepare('DELETE FROM samples WHERE at < ?').run(at - 30 * 86400000);
      this.db.prepare('DELETE FROM commands WHERE at < ?').run(at - 90 * 86400000);
      this.lastPruned = at;
    }
  }
  requested(cmd) {
    this.db.prepare('INSERT OR IGNORE INTO commands(id,at,body) VALUES(?,?,?)').run(cmd.cmdId, cmd.issuedAt, JSON.stringify(cmd));
  }
  complete(ack) { this.db.prepare('UPDATE commands SET ack=? WHERE id=?').run(JSON.stringify(ack), ack.cmdId); }
  command(id) {
    const row = this.db.prepare('SELECT body,ack FROM commands WHERE id=?').get(id);
    return row ? { command: JSON.parse(row.body), ack: row.ack ? JSON.parse(row.ack) : null } : null;
  }
  history(hours = 1) {
    const after = Date.now() - hours * 3600000;
    const bucket = Math.max(1000, Math.ceil(hours * 3600000 / 900));
    return this.db.prepare('SELECT at,body FROM samples WHERE id IN (SELECT MAX(id) FROM samples WHERE at>=? GROUP BY CAST(at / ? AS INTEGER)) ORDER BY at').all(after, bucket)
      .map(row => ({ at: row.at, ...validateData(JSON.parse(row.body)) }));
  }
  logs() {
    return this.db.prepare('SELECT id,at,body,ack FROM commands ORDER BY at DESC LIMIT 100').all()
      .map(row => ({ cmdId: row.id, at: row.at, command: JSON.parse(row.body), ack: row.ack ? JSON.parse(row.ack) : null }));
  }
  close() { this.db.close(); }
}
