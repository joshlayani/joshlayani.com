const express = require("express");
const nodemailer = require("nodemailer");
const { Pool } = require("pg");

const MAX_METADATA_LENGTH = 8000;
const DIGEST_LOCK_NAMESPACE = 87231;
const DIGEST_LOCK_KEY = 44109;

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

function normalizeResumeRequestPayload(body) {
  const contactEmail = optionalText(body.contactEmail, 320);
  const jobTitle = optionalText(body.jobTitle, 200);
  const jobDescription = optionalText(body.jobDescription, 5000);
  const salary = optionalText(body.salary, 200);
  const sessionId = optionalText(body.sessionId, 120);
  const sourcePath = optionalText(body.sourcePath, 500) || "/";

  if (!contactEmail || !jobTitle || !jobDescription || !salary) {
    return {
      error: "contactEmail, jobTitle, jobDescription, and salary are required."
    };
  }

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(contactEmail)) {
    return {
      error: "A valid email address is required."
    };
  }

  return {
    contactEmail,
    jobTitle,
    jobDescription,
    salary,
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

function getDigestTimeZone() {
  return process.env.ANALYTICS_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function getDatePartsInTimeZone(value, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const parts = formatter.formatToParts(value);
  const byType = {};

  parts.forEach(function (part) {
    if (part.type !== "literal") {
      byType[part.type] = part.value;
    }
  });

  return {
    year: Number.parseInt(byType.year, 10),
    month: Number.parseInt(byType.month, 10),
    day: Number.parseInt(byType.day, 10)
  };
}

function formatDateParts(parts) {
  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0")
  ].join("-");
}

function getTimeZoneOffsetMilliseconds(value, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset"
  });
  const timeZonePart = formatter.formatToParts(value).find(function (part) {
    return part.type === "timeZoneName";
  });
  const offsetLabel = timeZonePart ? timeZonePart.value : "GMT";

  if (offsetLabel === "GMT" || offsetLabel === "UTC") {
    return 0;
  }

  const match = offsetLabel.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) {
    throw new Error("Unable to parse time zone offset for " + timeZone + ".");
  }

  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number.parseInt(match[2], 10);
  const minutes = Number.parseInt(match[3] || "0", 10);

  return sign * ((hours * 60) + minutes) * 60 * 1000;
}

function getZonedMidnightUtc(parts, timeZone) {
  const utcGuess = Date.UTC(parts.year, parts.month - 1, parts.day);
  const offset = getTimeZoneOffsetMilliseconds(new Date(utcGuess), timeZone);
  return new Date(utcGuess - offset);
}

function shiftDatePartsByDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  date.setUTCDate(date.getUTCDate() + days);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
}

function getDailyDigestRange(now, timeZone) {
  const resolvedTimeZone = timeZone || getDigestTimeZone();
  const endParts = getDatePartsInTimeZone(now, resolvedTimeZone);
  const startParts = shiftDatePartsByDays(endParts, -1);
  const start = getZonedMidnightUtc(startParts, resolvedTimeZone);
  const end = getZonedMidnightUtc(endParts, resolvedTimeZone);

  return {
    digestDate: formatDateParts(startParts),
    start,
    end,
    timeZone: resolvedTimeZone
  };
}

async function loadDailyDigestSummary(db, range) {
  const trafficResult = await db.query(
    `
      SELECT
        COUNT(*) FILTER (WHERE event_type = 'page_view')::int AS page_views,
        COUNT(*) FILTER (WHERE event_type = 'route_click')::int AS route_clicks,
        COUNT(*) FILTER (WHERE event_type = 'section_enter')::int AS section_entries,
        COUNT(*) FILTER (WHERE event_type = 'scroll_depth')::int AS scroll_events,
        COUNT(DISTINCT session_id)::int AS sessions
      FROM analytics_events
      WHERE created_at >= $1
        AND created_at < $2;
    `,
    [range.start, range.end]
  );

  const routeResult = await db.query(
    `
      SELECT
        COALESCE(NULLIF(route_target, ''), 'unknown') AS route_target,
        COUNT(*)::int AS clicks
      FROM analytics_events
      WHERE event_type = 'route_click'
        AND created_at >= $1
        AND created_at < $2
      GROUP BY 1
      ORDER BY clicks DESC, route_target ASC
      LIMIT 5;
    `,
    [range.start, range.end]
  );

  const referrerResult = await db.query(
    `
      SELECT
        COALESCE(NULLIF(referrer, ''), 'direct') AS referrer,
        COUNT(*)::int AS visits
      FROM analytics_events
      WHERE event_type = 'page_view'
        AND created_at >= $1
        AND created_at < $2
      GROUP BY 1
      ORDER BY visits DESC, referrer ASC
      LIMIT 5;
    `,
    [range.start, range.end]
  );

  const contactResult = await db.query(
    `
      SELECT COUNT(*)::int AS total
      FROM contact_submissions
      WHERE created_at >= $1
        AND created_at < $2;
    `,
    [range.start, range.end]
  );

  const resumeResult = await db.query(
    `
      SELECT COUNT(*)::int AS total
      FROM resume_requests
      WHERE created_at >= $1
        AND created_at < $2;
    `,
    [range.start, range.end]
  );

  return {
    digestDate: range.digestDate,
    timeZone: range.timeZone,
    traffic: trafficResult.rows[0],
    topRoutes: routeResult.rows,
    topReferrers: referrerResult.rows,
    contactSubmissions: contactResult.rows[0].total,
    resumeRequests: resumeResult.rows[0].total
  };
}

function formatList(items, formatter, emptyMessage) {
  if (!items.length) {
    return "- " + emptyMessage;
  }

  return items.map(function (item) {
    return "- " + formatter(item);
  }).join("\n");
}

function formatDailyDigestEmail(summary) {
  return [
    "joshlayani.com daily analytics digest",
    "Date: " + summary.digestDate + " (" + summary.timeZone + ")",
    "",
    "Traffic",
    "- Sessions: " + summary.traffic.sessions,
    "- Page views: " + summary.traffic.page_views,
    "- Route clicks: " + summary.traffic.route_clicks,
    "- Section entries: " + summary.traffic.section_entries,
    "- Scroll milestones: " + summary.traffic.scroll_events,
    "",
    "Leads",
    "- Resume requests: " + summary.resumeRequests,
    "- Messages: " + summary.contactSubmissions,
    "",
    "Top routes",
    formatList(summary.topRoutes, function (route) {
      return route.route_target + ": " + route.clicks + " clicks";
    }, "No route clicks recorded."),
    "",
    "Top referrers",
    formatList(summary.topReferrers, function (referrer) {
      return referrer.referrer + ": " + referrer.visits + " page views";
    }, "No page view referrers recorded.")
  ].join("\n");
}

async function maybeSendDailyDigest(options) {
  const pool = options.pool;
  const mailer = options.mailer;
  const notificationEmail = options.notificationEmail;
  const now = options.now || new Date();

  if (!pool || !mailer || !notificationEmail) {
    return {
      sent: false,
      reason: "disabled"
    };
  }

  const range = getDailyDigestRange(now, options.timeZone);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const lockResult = await client.query(
      "SELECT pg_try_advisory_xact_lock($1, $2) AS locked;",
      [DIGEST_LOCK_NAMESPACE, DIGEST_LOCK_KEY]
    );

    if (!lockResult.rows[0].locked) {
      await client.query("ROLLBACK");
      return {
        sent: false,
        reason: "locked"
      };
    }

    const sentResult = await client.query(
      `
        SELECT digest_date
        FROM analytics_digest_runs
        WHERE digest_date = $1
        FOR UPDATE;
      `,
      [range.digestDate]
    );

    if (sentResult.rowCount > 0) {
      await client.query("COMMIT");
      return {
        sent: false,
        reason: "already_sent",
        digestDate: range.digestDate
      };
    }

    const summary = await loadDailyDigestSummary(client, range);

    await mailer.sendMail({
      from: process.env.CONTACT_FROM_EMAIL || notificationEmail,
      to: notificationEmail,
      subject: "joshlayani.com daily analytics digest for " + range.digestDate,
      text: formatDailyDigestEmail(summary)
    });

    await client.query(
      `
        INSERT INTO analytics_digest_runs (
          digest_date,
          sent_at,
          recipient_email,
          summary
        ) VALUES ($1, NOW(), $2, $3::jsonb);
      `,
      [range.digestDate, notificationEmail, JSON.stringify(summary)]
    );

    await client.query("COMMIT");

    return {
      sent: true,
      digestDate: range.digestDate
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Failed to roll back daily digest transaction", rollbackError);
    }

    throw error;
  } finally {
    client.release();
  }
}

function startDailyDigestScheduler(options) {
  const pool = options.pool;
  const mailer = options.mailer;
  const notificationEmail = options.notificationEmail;
  const timeZone = options.timeZone || getDigestTimeZone();
  const intervalMinutes = Number.parseInt(process.env.ANALYTICS_DIGEST_CHECK_INTERVAL_MINUTES || "15", 10);
  const intervalMs = Math.max(intervalMinutes, 5) * 60 * 1000;
  let isRunning = false;

  if (!mailer || !notificationEmail) {
    console.log("Daily analytics digest disabled: mailer or recipient missing.");
    return null;
  }

  async function tick() {
    if (isRunning) {
      return;
    }

    isRunning = true;

    try {
      const result = await maybeSendDailyDigest({
        pool,
        mailer,
        notificationEmail,
        timeZone
      });

      if (result.sent) {
        console.log("Daily analytics digest sent for " + result.digestDate);
      }
    } catch (error) {
      console.error("Failed to send daily analytics digest", error);
    } finally {
      isRunning = false;
    }
  }

  const timeout = setTimeout(tick, 5000);
  const interval = setInterval(tick, intervalMs);

  return {
    stop() {
      clearTimeout(timeout);
      clearInterval(interval);
    }
  };
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

  app.post("/api/resume-request", async function (request, response, next) {
    try {
      const payload = normalizeResumeRequestPayload(request.body || {});

      if (payload.error) {
        response.status(400).json({ error: payload.error });
        return;
      }

      const result = await pool.query(
        `
          INSERT INTO resume_requests (
            session_id,
            contact_email,
            job_title,
            job_description,
            salary,
            source_path
          ) VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING id, created_at;
        `,
        [
          payload.sessionId,
          payload.contactEmail,
          payload.jobTitle,
          payload.jobDescription,
          payload.salary,
          payload.sourcePath
        ]
      );

      let emailDelivered = false;

      if (mailer && notificationEmail) {
        try {
          await mailer.sendMail({
            from: process.env.CONTACT_FROM_EMAIL || notificationEmail,
            to: notificationEmail,
            replyTo: payload.contactEmail,
            subject: "New joshlayani.com resume request",
            text:
              "Contact email: " + payload.contactEmail + "\n" +
              "Job title: " + payload.jobTitle + "\n" +
              "Salary: " + payload.salary + "\n" +
              "Source path: " + payload.sourcePath + "\n" +
              "Submitted at: " + result.rows[0].created_at.toISOString() + "\n\n" +
              "Job description:\n" + payload.jobDescription
          });

          emailDelivered = true;

          await pool.query(
            `
              UPDATE resume_requests
              SET notification_sent = TRUE
              WHERE id = $1;
            `,
            [result.rows[0].id]
          );
        } catch (mailError) {
          console.error("Failed to send resume request email", mailError);
        }
      }

      response.status(201).json({
        ok: true,
        requestId: result.rows[0].id,
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
  const notificationEmail = process.env.CONTACT_TO_EMAIL || null;
  const digestEmail = process.env.ANALYTICS_DIGEST_TO_EMAIL || notificationEmail;
  const digestTimeZone = getDigestTimeZone();
  const app = createApp({
    pool,
    mailer,
    notificationEmail
  });
  const port = Number.parseInt(process.env.PORT || "3001", 10);

  await ensureSchema(pool);

  const server = app.listen(port, function () {
    console.log("Analytics API listening on port " + port);
  });
  const digestScheduler = startDailyDigestScheduler({
    pool,
    mailer,
    notificationEmail: digestEmail,
    timeZone: digestTimeZone
  });

  async function shutdown() {
    if (digestScheduler) {
      digestScheduler.stop();
    }

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
  formatDailyDigestEmail,
  getDailyDigestRange,
  getDigestTimeZone,
  maybeSendDailyDigest,
  normalizeContactPayload,
  normalizeResumeRequestPayload,
  normalizeEventPayload
};
