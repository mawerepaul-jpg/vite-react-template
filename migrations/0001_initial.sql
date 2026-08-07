PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pricing_rules (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  markup_rate REAL NOT NULL DEFAULT 6,
  customs_rate REAL NOT NULL DEFAULT 10,
  delivery_rate REAL NOT NULL DEFAULT 30,
  deposit_rate REAL NOT NULL DEFAULT 40,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO pricing_rules (id, markup_rate, customs_rate, delivery_rate, deposit_rate, updated_at)
VALUES (1, 6, 10, 30, 40, CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_code TEXT NOT NULL UNIQUE,
  tracking_token TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  delivery_method TEXT NOT NULL CHECK (delivery_method IN ('collection', 'delivery')),
  delivery_address TEXT,
  payment_reference TEXT NOT NULL,
  status TEXT NOT NULL,
  subtotal REAL NOT NULL,
  markup_amount REAL NOT NULL,
  customs_amount REAL NOT NULL,
  delivery_amount REAL NOT NULL,
  total_amount REAL NOT NULL,
  deposit_amount REAL NOT NULL,
  balance_amount REAL NOT NULL,
  markup_rate REAL NOT NULL,
  customs_rate REAL NOT NULL,
  delivery_rate REAL NOT NULL,
  deposit_rate REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_link TEXT,
  product_name TEXT,
  unit_price REAL NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity >= 1),
  notes TEXT
);

CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
