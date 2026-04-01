(function () {
  const scrollSections = Array.from(document.querySelectorAll(".scroll-section[data-route-target]"));
  const routeCards = Array.from(document.querySelectorAll("[data-route-card]"));
  const randomProjectLinks = Array.from(document.querySelectorAll("[data-random-project]"));
  const contactForm = document.getElementById("contact-form");
  const resumeForm = document.getElementById("resume-form");
  const contactStatus = document.getElementById("contact-status");
  const resumeStatus = document.getElementById("resume-status");
  const sessionId = getSessionId();
  const projectDestinations = [
    {
      label: "Olivia",
      href: "https://olivia.joshlayani.com"
    },
    {
      label: "Tix",
      href: "https://tix.joshlayani.com"
    },
    {
      label: "WhatTheChef",
      href: "https://whatthechef.joshlayani.com"
    }
  ];
  const seenSections = new Set();
  const intersectionRatios = new Map();
  let currentRouteTarget = "overview";

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

  function getSectionState(section) {
    return {
      id: section.id || section.dataset.routeTarget || "overview",
      routeTarget: section.dataset.routeTarget || "overview",
      routeName: section.dataset.routeName || "Overview",
      progress: Number(section.dataset.progress || "0.17")
    };
  }

  function pickRandomProject() {
    const projectIndex = Math.floor(Math.random() * projectDestinations.length);
    return projectDestinations[projectIndex];
  }

  async function readJsonResponse(response) {
    const responseText = await response.text();

    if (!responseText) {
      return {};
    }

    try {
      return JSON.parse(responseText);
    } catch (error) {
      if (!response.ok) {
        return {
          error: "The form service returned an unexpected response."
        };
      }

      throw error;
    }
  }

  function activateSection(section) {
    if (!section) {
      return;
    }

    const state = getSectionState(section);

    currentRouteTarget = state.routeTarget;
    document.body.dataset.activeRoute = state.routeTarget;

    scrollSections.forEach(function (currentSection) {
      currentSection.classList.toggle("is-active", currentSection === section);
    });

    if (!seenSections.has(state.id)) {
      seenSections.add(state.id);
      sendEvent("section_enter", {
        funnel: state.routeTarget,
        audience: state.routeName,
        stepId: state.id,
        routeTarget: state.routeTarget,
        metadata: {
          progress: state.progress
        }
      });
    }
  }

  function pickActiveSection() {
    let bestSection = scrollSections[0];
    let bestRatio = -1;

    scrollSections.forEach(function (section) {
      const ratio = intersectionRatios.get(section) || 0;
      if (ratio > bestRatio) {
        bestRatio = ratio;
        bestSection = section;
      }
    });

    activateSection(bestSection);
  }

  if (scrollSections.length) {
    const observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        intersectionRatios.set(entry.target, entry.intersectionRatio);
      });

      pickActiveSection();
    }, {
      threshold: [0.2, 0.35, 0.5, 0.7, 0.9],
      rootMargin: "-12% 0px -18% 0px"
    });

    scrollSections.forEach(function (section) {
      observer.observe(section);
    });

    activateSection(scrollSections[0]);
  }

  routeCards.forEach(function (card) {
    card.addEventListener("click", function () {
      if (card.hasAttribute("data-random-project")) {
        return;
      }

      sendEvent("route_click", {
        funnel: card.dataset.routeTarget || "unknown",
        audience: currentRouteTarget,
        stepId: currentRouteTarget,
        routeTarget: card.dataset.routeTarget || "unknown",
        metadata: {
          href: card.getAttribute("href")
        }
      });
    });
  });

  randomProjectLinks.forEach(function (link) {
    link.addEventListener("click", function () {
      const destination = pickRandomProject();
      link.href = destination.href;

      sendEvent("route_click", {
        funnel: "random-project",
        audience: currentRouteTarget,
        stepId: currentRouteTarget,
        routeTarget: "random-project",
        metadata: {
          href: destination.href,
          project: destination.label
        }
      });
    });
  });

  function bindFormSubmission(options) {
    const { form, endpoint, statusNode, eventType, routeTarget, buildPayload, getSuccessMessage } = options;

    if (!form || !statusNode) {
      return;
    }

    form.addEventListener("submit", async function (event) {
      event.preventDefault();

      const submitButton = form.querySelector('button[type="submit"]');
      const formData = new FormData(form);
      const payload = buildPayload(formData);
      statusNode.textContent = "Sending...";
      submitButton.disabled = true;

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json"
          },
          body: JSON.stringify(payload)
        });

        const result = await readJsonResponse(response);

        if (!response.ok) {
          throw new Error(result.error || "Unable to submit form.");
        }

        form.reset();
        statusNode.textContent = getSuccessMessage(result);

        sendEvent(eventType, {
          funnel: routeTarget,
          audience: routeTarget,
          stepId: routeTarget,
          routeTarget,
          metadata: {
            emailDelivered: Boolean(result.emailDelivered)
          }
        });
      } catch (error) {
        statusNode.textContent = error.message || "Something went wrong while sending the form.";
      } finally {
        submitButton.disabled = false;
      }
    });
  }

  bindFormSubmission({
    form: contactForm,
    endpoint: "/api/contact",
    statusNode: contactStatus,
    eventType: "contact_submit",
    routeTarget: "message",
    buildPayload(formData) {
      return {
        sessionId,
        name: String(formData.get("name") || "").trim(),
        role: String(formData.get("role") || "").trim(),
        email: String(formData.get("email") || "").trim(),
        message: String(formData.get("message") || "").trim(),
        sourcePath: window.location.pathname + window.location.search
      };
    },
    getSuccessMessage(result) {
      return result.emailDelivered
        ? "Message sent. It reached Josh successfully."
        : "Message saved. Email alerts will send once SMTP is configured.";
    }
  });

  bindFormSubmission({
    form: resumeForm,
    endpoint: "/api/resume-request",
    statusNode: resumeStatus,
    eventType: "resume_request_submit",
    routeTarget: "resume",
    buildPayload(formData) {
      return {
        sessionId,
        contactEmail: String(formData.get("contactEmail") || "").trim(),
        jobTitle: String(formData.get("jobTitle") || "").trim(),
        jobDescription: String(formData.get("jobDescription") || "").trim(),
        salary: String(formData.get("salary") || "").trim(),
        sourcePath: window.location.pathname + window.location.search
      };
    },
    getSuccessMessage(result) {
      return result.emailDelivered
        ? "Resume request sent. Josh was notified by email."
        : "Resume request saved. Email alerts will send once SMTP is configured.";
    }
  });

  sendEvent("page_view", {
    funnel: "overview",
    audience: "Overview",
    stepId: "overview",
    metadata: {
      title: document.title
    }
  });
})();
