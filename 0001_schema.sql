-- PennyNest schema (idempotent). Applied by the platform deploy step;
-- the Worker also self-heals this schema at runtime.

CREATE TABLE IF NOT EXISTS users ( id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'user', avatar TEXT NOT NULL DEFAULT '🐼', theme TEXT NOT NULL DEFAULT 'matcha', pin_hash TEXT NOT NULL, pin_salt TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login_at TEXT );
CREATE TABLE IF NOT EXISTS sessions ( token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_seen_at TEXT NOT NULL DEFAULT (datetime('now')), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE );
CREATE TABLE IF NOT EXISTS transactions ( id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT NOT NULL, amount REAL NOT NULL, type TEXT NOT NULL, category TEXT NOT NULL, date TEXT NOT NULL, is_sample INTEGER NOT NULL DEFAULT 0, sample_day TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE );
CREATE TABLE IF NOT EXISTS budgets ( user_id INTEGER NOT NULL, category TEXT NOT NULL, monthly_limit REAL NOT NULL, PRIMARY KEY (user_id, category), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE );
CREATE TABLE IF NOT EXISTS goals ( id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT NOT NULL, target REAL NOT NULL, saved REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE );
CREATE TABLE IF NOT EXISTS cozy_nests ( id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL, title TEXT NOT NULL, target REAL NOT NULL, saved REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT, FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE );
CREATE TABLE IF NOT EXISTS nest_members ( nest_id INTEGER NOT NULL, user_id INTEGER NOT NULL, joined_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (nest_id, user_id), FOREIGN KEY (nest_id) REFERENCES cozy_nests(id) ON DELETE CASCADE, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE );
CREATE TABLE IF NOT EXISTS nest_contributions ( id INTEGER PRIMARY KEY AUTOINCREMENT, nest_id INTEGER NOT NULL, user_id INTEGER NOT NULL, amount REAL NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), FOREIGN KEY (nest_id) REFERENCES cozy_nests(id) ON DELETE CASCADE, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE );
CREATE TABLE IF NOT EXISTS nest_messages ( id INTEGER PRIMARY KEY AUTOINCREMENT, nest_id INTEGER NOT NULL, user_id INTEGER, sender_label TEXT NOT NULL DEFAULT 'Member', body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), FOREIGN KEY (nest_id) REFERENCES cozy_nests(id) ON DELETE CASCADE );
CREATE TABLE IF NOT EXISTS admin_messages ( id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, admin_id INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), read_at TEXT, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE );
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_goals_user ON goals(user_id);
CREATE INDEX IF NOT EXISTS idx_nest_members_user ON nest_members(user_id);
CREATE INDEX IF NOT EXISTS idx_nest_messages_nest ON nest_messages(nest_id);
CREATE INDEX IF NOT EXISTS idx_admin_messages_user ON admin_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
