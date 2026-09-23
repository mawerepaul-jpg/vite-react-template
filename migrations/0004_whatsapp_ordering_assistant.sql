-- LELE Runner inbound WhatsApp ordering assistant. Run once after 0003.
CREATE TABLE IF NOT EXISTS whatsapp_conversations (
  customer_phone TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'menu',
  draft_json TEXT,
  last_order_code TEXT,
  marketing_opted_in INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS whatsapp_inbound_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meta_message_id TEXT UNIQUE,
  customer_phone TEXT NOT NULL,
  message_type TEXT NOT NULL,
  message_text TEXT,
  media_id TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS whatsapp_product_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  item_position INTEGER NOT NULL,
  media_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS whatsapp_support_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_phone TEXT NOT NULL,
  message TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_inbound_phone ON whatsapp_inbound_messages(customer_phone);
CREATE INDEX IF NOT EXISTS idx_whatsapp_media_order ON whatsapp_product_media(order_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_support_open ON whatsapp_support_requests(resolved_at);
