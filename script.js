(function () {
  const steps = Array.from(document.querySelectorAll(".story-step"));
  const routeCards = Array.from(document.querySelectorAll("[data-route-card]"));
  const progressBar = document.getElementById("story-progress");
  const activeTitle = document.getElementById("active-step-title");
  const activeDescription = document.getElementById("active-step-description");
  const activeFocus = document.getElementById("active-step-focus");
  const activeRoute = document.getElementById("active-step-route");
  const analyticsStatus = document.getElementById("analytics-status");
  const analyticsInsights = document.getElementById("analytics-insights");
  const routeMetricNodes = Array.from(document.querySelectorAll("[data-route-metric]"));
  const contactForm = document.getElementById("contact-form");
  const contactStatus = document.getElementById("contact-status");
  const contactSummary = document.getElementById("contact-summary");

  if (!steps.length) {
    return;
  }

  const milestones = [25, 50, 75, 100];
  const sentMilestones = new Set();
  const seenSteps = new Set();
  const intersectionRatios = new Map();
  const sessionId = getSessionId();
  let activeStepId = null;

  function getSessionId() {
    const storageKey = "joshlayani-session-id";
    const existingValue = window.sessionStorage.getItem(storageKey);

    if (existingValue) {
      return existingValue;
    }

    const generatedValue = (window.crypto && window.crypto.randomUUID)
      ? window.crypto.randomUUID()
      : "session-" + Math.random().toString(36).slice(2) + Date.now().toString(36);

    window.sessionStorage.setItem(storageKey, generatedValue);
    return generatedValue;
  }

  function slugify(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function sendEvent(eventType, details) {
    const payload = {
      sessionId,
      eventType,
      funnel: details.funnel || null,
      audience: details.audience || null,
      stepId: details.stepId || null,
      routeTarget: details.routeTarget || null,
      path: window.location.pathname + window.location.search,
      referrer: document.referrer || null,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      metadata: details.metadata || {}
    };

    const requestBody = JSON.stringify(payload);

    if (navigator.sendBeacon) {
      const beaconPayload = new Blob([requestBody], { type: "application/json" });
      navigator.sendBeacon("/api/events", beaconPayload);
      return;
    }

    fetch("/api/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: requestBody,
      keepalive: true
    }).catch(function () {
      return null;
    });
  }

  function getStepState(step) {
    return {
      id: step.dataset.step || step.id || "overview",
      title: (step.querySelector("h3") || {}).textContent || "Dispatch step",
      description: (step.querySelector("p") || {}).textContent || "",
      focus: step.dataset.focus || "Overview",
      route: step.dataset.route || "joshlayani.com",
      routeTarget: step.dataset.routeTarget || "overview",
      progress: Number(step.dataset.progress || "0.2")
    };
  }

  function renderSummary(summary) {
    const routeClicks = new Map();

    summary.topRoutes.forEach(function (route) {
      routeClicks.set(route.route_target, route.clicks);
    });

    routeMetricNodes.forEach(function (node) {
      const clicks = routeClicks.get(node.dataset.routeMetric) || 0;
      node.textContent = clicks + " tracked clicks";
    });

    analyticsInsights.textContent = "";

    if (!summary.topRoutes.length) {
      const emptyState = document.createElement("li");
      emptyState.textContent = "No route clicks yet. The first visitors will establish the baseline.";
      analyticsInsights.appendChild(emptyState);
      return;
    }

    summary.topRoutes.slice(0, 4).forEach(function (route) {
      const listItem = document.createElement("li");
      listItem.textContent = route.route_target + ": " + route.clicks + " clicks";
      analyticsInsights.appendChild(listItem);
    });

    if (typeof summary.contactSubmissions === "number") {
      contactSummary.textContent = summary.contactSubmissions + " inquiries stored in Postgres over the selected window.";
    }
  }

  async function loadSummary() {
    try {
      const response = await fetch("/api/summary?days=30", {
        headers: {
          Accept: "application/json"
        }
      });

      if (!response.ok) {
        throw new Error("Unable to load summary.");
      }

      const summary = await response.json();
      analyticsStatus.textContent = "Last " + summary.days + " days of route clicks and inquiries, read live from Postgres.";
      renderSummary(summary);
    } catch (error) {
      analyticsStatus.textContent = "Analytics summary will appear once the API and database are live in production.";
      analyticsInsights.textContent = "";

      const fallbackItem = document.createElement("li");
      fallbackItem.textContent = "Collection is ready. Summary data will populate after deployment and first events.";
      analyticsInsights.appendChild(fallbackItem);
      contactSummary.textContent = "Recent inquiry volume will load from Postgres once the API is live.";
    }
  }

  function activateStep(step) {
    const stepState = getStepState(step);

    if (activeStepId === stepState.id) {
      return;
    }

    activeStepId = stepState.id;

    steps.forEach(function (currentStep) {
      currentStep.classList.toggle("is-active", currentStep === step);
    });

    routeCards.forEach(function (card) {
      card.classList.toggle("is-selected", card.dataset.routeTarget === stepState.routeTarget);
    });

    document.body.dataset.activeRoute = stepState.routeTarget;
    activeTitle.textContent = stepState.title.trim();
    activeDescription.textContent = stepState.description.trim();
    activeFocus.textContent = stepState.focus;
    activeRoute.textContent = stepState.route;
    progressBar.style.width = Math.max(stepState.progress * 100, 20) + "%";

    if (!seenSteps.has(stepState.id)) {
      seenSteps.add(stepState.id);
      sendEvent("section_enter", {
        funnel: stepState.routeTarget,
        audience: stepState.focus,
        stepId: stepState.id,
        routeTarget: stepState.routeTarget,
        metadata: {
          progress: stepState.progress
        }
      });
    }
  }

  function pickActiveStep() {
    let bestStep = steps[0];
    let bestRatio = -1;

    steps.forEach(function (step) {
      const ratio = intersectionRatios.get(step) || 0;
      if (ratio > bestRatio) {
        bestRatio = ratio;
        bestStep = step;
      }
    });

    activateStep(bestStep);
  }

  const observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      intersectionRatios.set(entry.target, entry.intersectionRatio);
    });

    pickActiveStep();
  }, {
    threshold: [0.2, 0.35, 0.5, 0.7, 0.9],
    rootMargin: "-15% 0px -25% 0px"
  });

  steps.forEach(function (step) {
    observer.observe(step);
  });

  function trackScrollDepth() {
    const scrollHeight = document.documentElement.scrollHeight - window.innerHeight;
    if (scrollHeight <= 0) {
      return;
    }

    const depth = Math.round((window.scrollY / scrollHeight) * 100);

    milestones.forEach(function (milestone) {
      if (depth >= milestone && !sentMilestones.has(milestone)) {
        sentMilestones.add(milestone);
        sendEvent("scroll_depth", {
          funnel: document.body.dataset.activeRoute || "overview",
          audience: activeFocus.textContent || "Overview",
          stepId: activeStepId,
          metadata: {
            milestone
          }
        });
      }
    });
  }

  let ticking = false;
  window.addEventListener("scroll", function () {
    if (ticking) {
      return;
    }

    ticking = true;
    window.requestAnimationFrame(function () {
      trackScrollDepth();
      ticking = false;
    });
  }, { passive: true });

  routeCards.forEach(function (card) {
    card.addEventListener("click", function () {
      sendEvent("route_click", {
        funnel: card.dataset.routeTarget || "unknown",
        audience: activeFocus.textContent || "Overview",
        stepId: activeStepId,
        routeTarget: card.dataset.routeTarget || "unknown",
        metadata: {
          href: card.getAttribute("href")
        }
      });
    });
  });

  if (contactForm) {
    contactForm.addEventListener("submit", async function (event) {
      event.preventDefault();

      const submitButton = contactForm.querySelector('button[type="submit"]');
      const formData = new FormData(contactForm);
      const payload = {
        sessionId,
        name: String(formData.get("name") || "").trim(),
        role: String(formData.get("role") || "").trim(),
        email: String(formData.get("email") || "").trim(),
        message: String(formData.get("message") || "").trim(),
        sourcePath: window.location.pathname + window.location.search
      };

      contactStatus.textContent = "Saving your message and sending Josh an email alert...";
      submitButton.disabled = true;

      try {
        const response = await fetch("/api/contact", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json"
          },
          body: JSON.stringify(payload)
        });

        const result = await response.json();

        if (!response.ok) {
          throw new Error(result.error || "Unable to send message.");
        }

        contactForm.reset();
        contactStatus.textContent = result.emailDelivered
          ? "Message sent. It was stored in Postgres and an email alert was sent."
          : "Message stored in Postgres. Email alerts will send once SMTP is configured.";

        sendEvent("contact_submit", {
          funnel: "contact",
          audience: "Contact",
          stepId: "contact",
          routeTarget: "contact",
          metadata: {
            emailDelivered: Boolean(result.emailDelivered)
          }
        });

        loadSummary();
      } catch (error) {
        contactStatus.textContent = error.message || "Something went wrong while sending your message.";
      } finally {
        submitButton.disabled = false;
      }
    });
  }

  sendEvent("page_view", {
    funnel: "overview",
    audience: "Overview",
    stepId: steps[0].dataset.step || "overview",
    metadata: {
      title: document.title
    }
  });

  activateStep(steps[0]);
  trackScrollDepth();
  loadSummary();
})();
