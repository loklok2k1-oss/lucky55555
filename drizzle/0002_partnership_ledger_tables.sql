DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  code TEXT NOT NULL DEFAULT 'CASH',
  currency TEXT NOT NULL DEFAULT 'HKD',
  action TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  qty REAL NOT NULL DEFAULT 0,
  fee REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  partner TEXT NOT NULL DEFAULT 'NONE',
  note TEXT NOT NULL DEFAULT '',
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE partners (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE stocks (
  code TEXT PRIMARY KEY,
  price REAL NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
--> statement-breakpoint
CREATE INDEX idx_tx_date ON transactions(date);
--> statement-breakpoint
CREATE INDEX idx_tx_partner ON transactions(partner);
--> statement-breakpoint
CREATE INDEX idx_tx_code ON transactions(code);
