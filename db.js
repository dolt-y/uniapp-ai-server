import sqlite3 from 'sqlite3';
import { config } from './config.js';

export const db = new sqlite3.Database(config.dbFile, (err) => {
  if (err) console.error(err.message);
  else console.log('Connected to SQLite3 database.');
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      openid TEXT PRIMARY KEY,
      nickname TEXT,
      avatarUrl TEXT,
      model TEXT DEFAULT 'deepseek-chat',
      lastLogin TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      openid TEXT,
      title TEXT,
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY(openid) REFERENCES users(openid)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS chat_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER,
      role TEXT,
      content TEXT,
      created_at TEXT,
      liked INTEGER DEFAULT 0,
      FOREIGN KEY(session_id) REFERENCES sessions(id)
    )
  `);
});

