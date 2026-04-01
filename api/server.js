const express = require("express");
const nodemailer = require("nodemailer");
const { Pool } = require("pg");

const MAX_METADATA_LENGTH = 8000;

function optionalText(value, maxLength) {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = String(value).trim();

  if (!normalized) {
    return null;
  }

  return normalized.slice(0, maxLength);
}

function optionalInteger(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const serialized = JSON.stringify(value);

  if (serialized.length > MAX_METADATA_LENGTH) {
    return {
      truncated: true,
      originalLength: serialized.length
    };
  }

  return JSON.parse(serialized);
}

function normalizeEventPayload(body) {
  const sessionId = optionalText(body.sessionId, 120);
  const eventType = optionalText(body.eventType, 80);

  if (!sessionId || !eventType) {
    return {
      error: "sessionId and eventType are required."
    };
  }

  return {
    sessionId,
    eventType,
    funnel: optionalText(body.funnel, 80),
    audience: optionalText(body.audience, 80),
    stepId: optionalText(body.stepId, 120),
    routeTarget: optionalText(body.routeTarget, 120),
    path: optionalText(body.path, 500) || "/",
    referrer: optionalText(body.referrer, 500),
    userAgent: optionalText(body.userAgent, 500),
    viewportWidth: optionalInteger(body.viewportWidth),
    viewportHeight: optionalInteger(body.viewportHeight),
    metadata: normalizeMetadata(body.metadata)
  };
}

function normalizeContactPayload(body) {
  const name = optionalText(body.name, 120);
  const role = optionalText(body.role, 160);
  const email = optionalText(body.email, 320);
  const message = optionalText(body.message, 5000);
  const sessionId = optionalText(body.sessionId, 120);
  const sourcePath = optionalText(body.sourcePath, 500) || "/";

  if (!name || !role || !email || !message) {
    return {
      error: "name, role, email, and message are required."
    };
  }

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(email)) {
    return {
      error: "A valid email address is required."
    };
  }

  return {
    name,
    role,
    email,
    message,
    sessionId,
    sourcePath
  };
}

function clampDays(value) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) {
    return 30;
  }

  return Math.min(Math.max(parsed, 1), 90);
}

async function ensureSchema(pool) {
  await pool.query(`
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
  `);
}

function createApp(options) {
  const { pool, mailer, notificationEmail } = options;
  const app = express();

  app.set("trust proxy", true);
  app.use(express.json({ limit: "32kb" }));

  app.get("/api/health", async function (request, response, next) {
    try {
      await pool.query("SELECT 1");
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/summary", async function (request, response, next) {
    try {
      const days = clampDays(request.query.days);
      const funnelSummary = await pool.query(
        `
          SELECT
            COALESCE(NULLIF(funnel, ''), 'unknown') AS funnel,
            COUNT(*)::int AS total_events,
            COUNT(*) FILTER (WHERE event_type = 'route_click')::int AS route_clicks,
            COUNT(*) FILTER (WHERE event_type = 'section_enter')::int AS section_entries
          FROM analytics_events
          WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
          GROUP BY 1
          ORDER BY route_clicks DESC, total_events DESC;
        `,
        [days]
      );

      const routeSummary = await pool.query(
        `
          SELECT
            COALESCE(NULLIF(route_target, ''), 'unknown') AS route_target,
            COUNT(*)::int AS clicks
          FROM analytics_events
          WHERE event_type = 'route_click'
            AND created_at >= NOW() - ($1::int * INTERVAL '1 day')
          GROUP BY 1
          ORDER BY clicks DESC, route_target ASC;
        `,
        [days]
      );

      const contactSummary = await pool.query(
        `
          SELECT COUNT(*)::int AS total
          FROM contact_submissions
          WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day');
        `,
        [days]
      );

      response.json({
        days,
        byFunnel: funnelSummary.rows,
        topRoutes: routeSummary.rows,
        contactSubmissions: contactSummary.rows[0].total
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/events", async function (request, response, next) {
    try {
      const payload = normalizeEventPayload(request.body || {});

      if (payload.error) {
        response.status(400).json({ error: payload.error });
        return;
      }

      const result = await pool.query(
        `
          INSERT INTO analytics_events (
            session_id,
            event_type,
            funnel,
            audience,
            step_id,
            route_target,
            path,
            referrer,
            user_agent,
            viewport_width,
            viewport_height,
            metadata
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb
          )
          RETURNING id, created_at;
        `,
        [
          payload.sessionId,
          payload.eventType,
          payload.funnel,
          payload.audience,
          payload.stepId,
          payload.routeTarget,
          payload.path,
          payload.referrer,
          payload.userAgent || request.get("user-agent") || null,
          payload.viewportWidth,
          payload.viewportHeight,
          JSON.stringify(payload.metadata)
        ]
      );

      response.status(201).json({
        ok: true,
        eventId: result.rows[0].id,
        createdAt: result.rows[0].created_at
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/contact", async function (request, response, next) {
    try {
      const payload = normalizeContactPayload(request.body || {});

      if (payload.error) {
        response.status(400).json({ error: payload.error });
        return;
      }

      const result = await pool.query(
        `
          INSERT INTO contact_submissions (
            session_id,
            name,
            role,
            email,
            message,
            source_path
          ) VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING id, created_at;
        `,
        [
          payload.sessionId,
          payload.name,
          payload.role,
          payload.email,
          payload.message,
          payload.sourcePath
        ]
      );

      let emailDelivered = false;

      if (mailer && notificationEmail) {
        try {
          await mailer.sendMail({
            from: process.env.CONTACT_FROM_EMAIL || notificationEmail,
            to: notificationEmail,
            replyTo: payload.email,
            subject: "New joshlayani.com contact form submission",
            text:
              "Name: " + payload.name + "\n" +
              "What they do: " + payload.role + "\n" +
              "Email: " + payload.email + "\n" +
              "Source path: " + payload.sourcePath + "\n" +
              "Submitted at: " + result.rows[0].created_at.toISOString() + "\n\n" +
              payload.message
          });

          emailDelivered = true;

          await pool.query(
            `
              UPDATE contact_submissions
              SET notification_sent = TRUE
              WHERE id = $1;
            `,
            [result.rows[0].id]
          );
        } catch (mailError) {
          console.error("Failed to send contact submission email", mailError);
        }
      }

      response.status(201).json({
        ok: true,
        submissionId: result.rows[0].id,
        createdAt: result.rows[0].created_at,
        emailDelivered
      });
    } catch (error) {
      next(error);
    }
  });

  app.use(function (error, request, response, next) {
    if (error instanceof SyntaxError && Object.prototype.hasOwnProperty.call(error, "body")) {
      response.status(400).json({ error: "Invalid JSON payload." });
      return;
    }

    console.error(error);
    response.status(500).json({ error: "Internal server error." });
  });

  return app;
}

function createPoolFromEnv() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required.");
  }

  const useSsl = String(process.env.DATABASE_SSL || "").toLowerCase() === "true";

  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined
  });
}

function createMailerFromEnv() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_PORT) {
    return null;
  }

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number.parseInt(process.env.SMTP_PORT, 10),
    secure: String(process.env.SMTP_SECURE || "").toLowerCase() === "true",
    auth: process.env.SMTP_USER
      ? {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS || ""
        }
      : undefined
  });
}

async function startServer() {
  const pool = createPoolFromEnv();
  const mailer = createMailerFromEnv();
  const app = createApp({
    pool,
    mailer,
    notificationEmail: process.env.CONTACT_TO_EMAIL || null
  });
  const port = Number.parseInt(process.env.PORT || "3001", 10);

  await ensureSchema(pool);

  const server = app.listen(port, function () {
    console.log("Analytics API listening on port " + port);
  });

  async function shutdown() {
    server.close(async function () {
      await pool.end();
      process.exit(0);
    });
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  startServer().catch(function (error) {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  clampDays,
  createApp,
  ensureSchema,
  normalizeContactPayload,
  normalizeEventPayload
};
