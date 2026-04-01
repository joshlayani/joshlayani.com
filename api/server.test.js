const test = require("node:test");
const assert = require("node:assert/strict");

const {
  clampDays,
  getPoolConfigFromEnv,
  formatDailyDigestEmail,
  getDailyDigestRange,
  getDigestTimeZone,
  getMessageNotificationEmail,
  getResumeNotificationEmail,
  normalizeContactPayload,
  normalizeEventPayload,
  normalizeResumeRequestPayload,
  sanitizeDatabaseUrl
} = require("./server");

test("normalizeEventPayload requires sessionId and eventType", function () {
  const result = normalizeEventPayload({
    metadata: {
      step: "overview"
    }
  });

  assert.equal(result.error, "sessionId and eventType are required.");
});

test("normalizeEventPayload normalizes and trims analytics fields", function () {
  const result = normalizeEventPayload({
    sessionId: "  abc-123  ",
    eventType: " route_click ",
    funnel: " portfolio ",
    audience: " Portfolio ",
    stepId: " step-portfolio ",
    routeTarget: " portfolio ",
    path: " / ",
    referrer: " https://example.com/portfolio ",
    viewportWidth: "1440",
    viewportHeight: "900",
    metadata: {
      href: "https://portfolio.joshlayani.com"
    }
  });

  assert.equal(result.sessionId, "abc-123");
  assert.equal(result.eventType, "route_click");
  assert.equal(result.funnel, "portfolio");
  assert.equal(result.audience, "Portfolio");
  assert.equal(result.stepId, "step-portfolio");
  assert.equal(result.routeTarget, "portfolio");
  assert.equal(result.path, "/");
  assert.equal(result.viewportWidth, 1440);
  assert.deepEqual(result.metadata, {
    href: "https://portfolio.joshlayani.com"
  });
});

test("clampDays bounds summary queries", function () {
  assert.equal(clampDays(undefined), 30);
  assert.equal(clampDays("0"), 1);
  assert.equal(clampDays("200"), 90);
  assert.equal(clampDays("14"), 14);
});

test("normalizeContactPayload validates required fields", function () {
  const result = normalizeContactPayload({
    name: "Josh"
  });

  assert.equal(result.error, "name, role, email, and message are required.");
});

test("normalizeContactPayload trims and validates contact submissions", function () {
  const result = normalizeContactPayload({
    sessionId: "  session-123  ",
    name: "  Taylor  ",
    role: "  Product designer  ",
    email: "  taylor@example.com  ",
    message: "  Looking to chat about a project.  ",
    sourcePath: "  /  "
  });

  assert.equal(result.sessionId, "session-123");
  assert.equal(result.name, "Taylor");
  assert.equal(result.role, "Product designer");
  assert.equal(result.email, "taylor@example.com");
  assert.equal(result.message, "Looking to chat about a project.");
  assert.equal(result.sourcePath, "/");
});

test("normalizeResumeRequestPayload validates required fields", function () {
  const result = normalizeResumeRequestPayload({
    contactEmail: "recruiter@example.com"
  });

  assert.equal(result.error, "contactEmail, jobTitle, jobDescription, and salary are required.");
});

test("normalizeResumeRequestPayload trims and validates resume requests", function () {
  const result = normalizeResumeRequestPayload({
    sessionId: "  session-456  ",
    contactEmail: "  recruiter@example.com  ",
    jobTitle: "  Senior Product Engineer  ",
    jobDescription: "  Build product and ship end to end.  ",
    salary: "  $180k - $220k  ",
    sourcePath: "  /  "
  });

  assert.equal(result.sessionId, "session-456");
  assert.equal(result.contactEmail, "recruiter@example.com");
  assert.equal(result.jobTitle, "Senior Product Engineer");
  assert.equal(result.jobDescription, "Build product and ship end to end.");
  assert.equal(result.salary, "$180k - $220k");
  assert.equal(result.sourcePath, "/");
});

test("getDailyDigestRange targets the previous local day in the configured timezone", function () {
  const range = getDailyDigestRange(
    new Date("2026-04-01T05:30:00.000Z"),
    "America/Toronto"
  );

  assert.equal(range.digestDate, "2026-03-31");
  assert.equal(range.timeZone, "America/Toronto");
  assert.equal(range.start.toISOString(), "2026-03-31T04:00:00.000Z");
  assert.equal(range.end.toISOString(), "2026-04-01T04:00:00.000Z");
});

test("getDigestTimeZone reads the configured environment variable", function () {
  const original = process.env.ANALYTICS_TIMEZONE;
  process.env.ANALYTICS_TIMEZONE = "America/Toronto";

  try {
    assert.equal(getDigestTimeZone(), "America/Toronto");
  } finally {
    if (original === undefined) {
      delete process.env.ANALYTICS_TIMEZONE;
    } else {
      process.env.ANALYTICS_TIMEZONE = original;
    }
  }
});

test("sanitizeDatabaseUrl removes SSL query settings when DATABASE_SSL is enabled", function () {
  const sanitized = sanitizeDatabaseUrl(
    "postgres://user:pass@db.joshlayani.com:5432/app?sslmode=require&sslrootcert=/tmp/ca.pem&foo=bar",
    true
  );
  const url = new URL(sanitized);

  assert.equal(url.searchParams.get("sslmode"), null);
  assert.equal(url.searchParams.get("sslrootcert"), null);
  assert.equal(url.searchParams.get("foo"), "bar");
});

test("getPoolConfigFromEnv prefers explicit SSL config over DATABASE_URL sslmode", function () {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalDatabaseSsl = process.env.DATABASE_SSL;

  process.env.DATABASE_URL = "postgres://user:pass@db.joshlayani.com:5432/app?sslmode=require";
  process.env.DATABASE_SSL = "true";

  try {
    const config = getPoolConfigFromEnv();

    assert.equal(config.connectionString.includes("sslmode=require"), false);
    assert.deepEqual(config.ssl, { rejectUnauthorized: false });
  } finally {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }

    if (originalDatabaseSsl === undefined) {
      delete process.env.DATABASE_SSL;
    } else {
      process.env.DATABASE_SSL = originalDatabaseSsl;
    }
  }
});

test("notification email helpers use contact and resume-specific recipients", function () {
  const originalContact = process.env.CONTACT_TO_EMAIL;
  const originalResume = process.env.RESUME_REQUEST_TO_EMAIL;

  process.env.CONTACT_TO_EMAIL = "hello@joshlayani.com";
  process.env.RESUME_REQUEST_TO_EMAIL = "requests@joshlayani.com";

  try {
    assert.equal(getMessageNotificationEmail(), "hello@joshlayani.com");
    assert.equal(getResumeNotificationEmail(), "requests@joshlayani.com");
  } finally {
    if (originalContact === undefined) {
      delete process.env.CONTACT_TO_EMAIL;
    } else {
      process.env.CONTACT_TO_EMAIL = originalContact;
    }

    if (originalResume === undefined) {
      delete process.env.RESUME_REQUEST_TO_EMAIL;
    } else {
      process.env.RESUME_REQUEST_TO_EMAIL = originalResume;
    }
  }
});

test("resume notifications fall back to the contact inbox", function () {
  const originalContact = process.env.CONTACT_TO_EMAIL;
  const originalResume = process.env.RESUME_REQUEST_TO_EMAIL;

  process.env.CONTACT_TO_EMAIL = "hello@joshlayani.com";
  delete process.env.RESUME_REQUEST_TO_EMAIL;

  try {
    assert.equal(getResumeNotificationEmail(), "hello@joshlayani.com");
  } finally {
    if (originalContact === undefined) {
      delete process.env.CONTACT_TO_EMAIL;
    } else {
      process.env.CONTACT_TO_EMAIL = originalContact;
    }

    if (originalResume === undefined) {
      delete process.env.RESUME_REQUEST_TO_EMAIL;
    } else {
      process.env.RESUME_REQUEST_TO_EMAIL = originalResume;
    }
  }
});

test("formatDailyDigestEmail renders a clean text summary", function () {
  const text = formatDailyDigestEmail({
    digestDate: "2026-03-31",
    timeZone: "America/Toronto",
    traffic: {
      sessions: 12,
      page_views: 18,
      route_clicks: 7,
      section_entries: 15,
      scroll_events: 9
    },
    topRoutes: [
      {
        route_target: "portfolio",
        clicks: 4
      }
    ],
    topReferrers: [
      {
        referrer: "direct",
        visits: 10
      }
    ],
    contactSubmissions: 2,
    resumeRequests: 1
  });

  assert.match(text, /Date: 2026-03-31 \(America\/Toronto\)/);
  assert.match(text, /Sessions: 12/);
  assert.match(text, /Resume requests: 1/);
  assert.match(text, /portfolio: 4 clicks/);
  assert.match(text, /direct: 10 page views/);
});
