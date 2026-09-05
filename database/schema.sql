CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS knowledge_entries (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS followup_tasks (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quote_history (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_users (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_logs (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quality_issues (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS products_data_gin_idx ON products USING GIN (data);
CREATE INDEX IF NOT EXISTS knowledge_entries_data_gin_idx ON knowledge_entries USING GIN (data);
CREATE INDEX IF NOT EXISTS customers_data_gin_idx ON customers USING GIN (data);
CREATE INDEX IF NOT EXISTS followup_tasks_data_gin_idx ON followup_tasks USING GIN (data);
CREATE UNIQUE INDEX IF NOT EXISTS products_sku_unique_idx ON products ((data ->> 'sku')) WHERE data ? 'sku';
CREATE UNIQUE INDEX IF NOT EXISTS products_model_unique_idx ON products ((data ->> 'model')) WHERE data ? 'model';
CREATE INDEX IF NOT EXISTS products_status_idx ON products ((data ->> 'status'));
CREATE INDEX IF NOT EXISTS customers_stage_idx ON customers ((data ->> 'stage'));
CREATE INDEX IF NOT EXISTS followup_tasks_customer_idx ON followup_tasks ((data ->> 'customerId'));
CREATE INDEX IF NOT EXISTS followup_tasks_status_due_idx ON followup_tasks ((data ->> 'status'), (data ->> 'dueAt'));
CREATE INDEX IF NOT EXISTS audit_events_entity_idx ON audit_events (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_request_idx ON audit_events (request_id);
