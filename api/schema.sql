CREATE TABLE IF NOT EXISTS analytics_events (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  funnel TEXT,
  audience TEXT,
  step_id TEXT,
  route_target TEXT,
  path TEXT NOT NULL,
  referrer TEXT,
  user_agent TEXT,
  viewport_width INTEGER,
  viewport_height INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS analytics_events_created_at_idx
  ON analytics_events (created_at DESC);

CREATE INDEX IF NOT EXISTS analytics_events_funnel_idx
  ON analytics_events (funnel);

CREATE INDEX IF NOT EXISTS analytics_events_route_target_idx
  ON analytics_events (route_target);

CREATE TABLE IF NOT EXISTS contact_submissions (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id TEXT,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  source_path TEXT NOT NULL DEFAULT '/',
  notification_sent BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS contact_submissions_created_at_idx
  ON contact_submissions (created_at DESC);

CREATE TABLE IF NOT EXISTS resume_requests (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id TEXT,
  contact_email TEXT NOT NULL,
  job_title TEXT NOT NULL,
  job_description TEXT NOT NULL,
  salary TEXT NOT NULL,
  source_path TEXT NOT NULL DEFAULT '/',
  notification_sent BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS resume_requests_created_at_idx
  ON resume_requests (created_at DESC);

CREATE TABLE IF NOT EXISTS analytics_digest_runs (
  digest_date DATE PRIMARY KEY,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recipient_email TEXT NOT NULL,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb
);
