(function () {
  const steps = Array.from(document.querySelectorAll(".story-step"));
  const routeCards = Array.from(document.querySelectorAll("[data-route-card]"));
  const randomProjectLinks = Array.from(document.querySelectorAll("[data-random-project]"));
  const progressBar = document.getElementById("story-progress");
  const activeTitle = document.getElementById("active-step-title");
  const activeDescription = document.getElementById("active-step-description");
  const activeFocus = document.getElementById("active-step-focus");
  const activeRoute = document.getElementById("active-step-route");
  const contactForm = document.getElementById("contact-form");
  const resumeForm = document.getElementById("resume-form");
  const contactStatus = document.getElementById("contact-status");
  const resumeStatus = document.getElementById("resume-status");

  if (!steps.length) {
    return;
  }

  const milestones = [25, 50, 75, 100];
  const sentMilestones = new Set();
  const seenSteps = new Set();
  const intersectionRatios = new Map();
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

  function pickRandomProject() {
    const projectIndex = Math.floor(Math.random() * projectDestinations.length);
    return projectDestinations[projectIndex];
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
      if (card.hasAttribute("data-random-project")) {
        return;
      }

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

  randomProjectLinks.forEach(function (link) {
    link.addEventListener("click", function () {
      const destination = pickRandomProject();
      link.href = destination.href;

      sendEvent("route_click", {
        funnel: "random-project",
        audience: activeFocus.textContent || "Overview",
        stepId: activeStepId,
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

        const result = await response.json();

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
    stepId: steps[0].dataset.step || "overview",
    metadata: {
      title: document.title
    }
  });

  activateStep(steps[0]);
  trackScrollDepth();
})();
