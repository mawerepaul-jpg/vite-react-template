-- LELE Runner WhatsApp notification log. Run once after 0002_core_operations.sql.
CREATE TABLE IF NOT EXISTS whatsapp_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER,
  recipient TEXT NOT NULL,
  event_status TEXT NOT NULL,
  delivery_state TEXT NOT NULL,
  template_name TEXT NOT NULL,
  provider_message_id TEXT,
  provider_response TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_notifications_order_id ON whatsapp_notifications(order_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_notifications_created_at ON whatsapp_notifications(created_at DESC);
