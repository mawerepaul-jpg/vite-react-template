-- LELE Runner core operations upgrade.
-- Run once in the Cloudflare D1 Console after the file is committed to GitHub.

ALTER TABLE admins ADD COLUMN role TEXT NOT NULL DEFAULT 'owner';

ALTER TABLE orders ADD COLUMN quote_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE orders ADD COLUMN customer_consent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN whatsapp_consent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN final_quote_note TEXT;
ALTER TABLE orders ADD COLUMN price_verified_at TEXT;
ALTER TABLE orders ADD COLUMN price_verified_by INTEGER;
ALTER TABLE orders ADD COLUMN quote_accepted_at TEXT;
ALTER TABLE orders ADD COLUMN payment_verified_at TEXT;
ALTER TABLE orders ADD COLUMN payment_verified_by INTEGER;
ALTER TABLE orders ADD COLUMN cancel_reason TEXT;
ALTER TABLE orders ADD COLUMN refund_amount REAL NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN refund_status TEXT;

ALTER TABLE order_events ADD COLUMN actor_email TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_events_order_id ON order_events(order_id);
