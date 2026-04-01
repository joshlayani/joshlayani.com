const test = require("node:test");
const assert = require("node:assert/strict");

const { clampDays, normalizeContactPayload, normalizeEventPayload } = require("./server");

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
