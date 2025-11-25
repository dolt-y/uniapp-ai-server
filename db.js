import sqlite3 from 'sqlite3';
import { config } from './config.js';

export const db = new sqlite3.Database(config.dbFile, (err) => {
  if (err) console.error(err.message);
  else console.log('Connected to SQLite3 database.');
});

db.serialize(() => {
  // users 表（新增 model 字段可选）
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      openid TEXT PRIMARY KEY,
      nickname TEXT,
      avatarUrl TEXT,
      model TEXT DEFAULT 'deepseek-chat',
      lastLogin TEXT
    )
  `);

  // sessions 表：使用本地时间，并增加 updated_at 的触发器
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      openid TEXT,
      title TEXT,
      created_at TEXT DEFAULT (DATETIME('now','localtime')),
      updated_at TEXT DEFAULT (DATETIME('now','localtime')),
      FOREIGN KEY(openid) REFERENCES users(openid)
    )
  `);

  // chat_records 表：使用本地时间
  db.run(`
    CREATE TABLE IF NOT EXISTS chat_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER,
      role TEXT,
      content TEXT,
      created_at TEXT DEFAULT (DATETIME('now','localtime')),
      FOREIGN KEY(session_id) REFERENCES sessions(id)
    )
  `);

  // 为 sessions 创建触发器：在行 UPDATE 时自动刷新 updated_at（本地时间）
  db.run(`
    CREATE TRIGGER IF NOT EXISTS sessions_update_timestamp
    AFTER UPDATE ON sessions
    FOR EACH ROW
    BEGIN
      UPDATE sessions SET updated_at = DATETIME('now','localtime') WHERE id = OLD.id;
    END;
  `);
});
