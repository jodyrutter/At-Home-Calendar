// Hearthboard ambient effects layer.
// Renders a low-overhead canvas behind the page that mixes:
//   - a drifting aurora gradient
//   - a slow vignette breathing in/out with the hour
//   - rising embers that catch the cursor
//   - drifting "fireflies" / dust motes
//
// Everything is pure DOM/canvas (no external libs) and respects the page's
// active theme via the `data-theme` attribute on <html>. Animation pauses
// when the document is hidden so it never burns CPU on background tabs.

const EMBER_COUNT = 42;
const SPARK_COUNT = 26;
const AURORA_BAND_COUNT = 3;

const root = document.documentElement;

function isDarkTheme() {
  return root.dataset.theme === "dark";
}

function ensureContainer() {
  let container = document.querySelector(".hearthboard-ambient");
  if (container) {
    return container;
  }

  container = document.createElement("div");
  container.className = "hearthboard-ambient";
  container.setAttribute("aria-hidden", "true");

  const aurora = document.createElement("div");
  aurora.className = "hearthboard-ambient-aurora";
  for (let index = 0; index < AURORA_BAND_COUNT; index += 1) {
    const ribbon = document.createElement("span");
    ribbon.className = `hearthboard-aurora-ribbon hearthboard-aurora-ribbon-${index + 1}`;
    aurora.append(ribbon);
  }

  const hearth = document.createElement("div");
  hearth.className = "hearthboard-ambient-hearth";

  const canvas = document.createElement("canvas");
  canvas.className = "hearthboard-ambient-canvas";

  container.append(aurora, hearth, canvas);
  document.body.prepend(container);
  document.body.classList.add("has-hearthboard-ambient");
  return container;
}

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function makeEmber(width, height) {
  return {
    x: rand(0, width),
    y: rand(height * 0.6, height + 60),
    vx: rand(-0.18, 0.18),
    vy: rand(-0.55, -0.18),
    size: rand(1.4, 3.6),
    life: rand(0.4, 1),
    maxLife: rand(4, 10),
    age: rand(0, 6),
    hue: rand(18, 42),
    twinkle: rand(0, Math.PI * 2)
  };
}

function makeSpark(width, height) {
  return {
    x: rand(0, width),
    y: rand(0, height),
    radius: rand(0.6, 1.6),
    drift: rand(-0.08, 0.08),
    bob: rand(-0.05, 0.05),
    phase: rand(0, Math.PI * 2),
    speed: rand(0.0009, 0.0024)
  };
}

function paintAurora(ctx, width, height, time) {
  // Soft moving gradient washes that fake an aurora across the top half.
  const dark = isDarkTheme();
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (let band = 0; band < AURORA_BAND_COUNT; band += 1) {
    const offset = (time * 0.00006 + band * 0.31) % 1;
    const cx = width * (0.2 + 0.6 * ((Math.sin(time * 0.00012 + band) + 1) / 2));
    const cy = height * (0.18 + band * 0.05);
    const radius = Math.max(width, height) * 0.55;
    const gradient = ctx.createRadialGradient(cx, cy, 10, cx, cy, radius);
    if (dark) {
      gradient.addColorStop(0, `rgba(${band === 1 ? "255, 168, 92" : "120, 220, 200"}, 0.18)`);
      gradient.addColorStop(0.4, `rgba(${band === 0 ? "240, 138, 67" : "44, 195, 179"}, 0.07)`);
      gradient.addColorStop(1, "rgba(8, 12, 22, 0)");
    } else {
      gradient.addColorStop(0, `rgba(${band === 1 ? "255, 196, 132" : "180, 232, 215"}, 0.32)`);
      gradient.addColorStop(0.4, `rgba(${band === 0 ? "248, 168, 92" : "115, 200, 188"}, 0.16)`);
      gradient.addColorStop(1, "rgba(255, 250, 240, 0)");
    }

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(cx + Math.sin(offset * Math.PI * 2) * width * 0.08, cy, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function paintEmber(ctx, ember, dark) {
  const fade = Math.max(0, 1 - ember.age / ember.maxLife);
  const alpha = (0.45 + Math.sin(ember.twinkle) * 0.25) * fade;
  const color = dark
    ? `hsla(${ember.hue}, 95%, 62%, ${alpha})`
    : `hsla(${ember.hue}, 88%, 52%, ${alpha * 0.85})`;

  const halo = ctx.createRadialGradient(ember.x, ember.y, 0, ember.x, ember.y, ember.size * 6);
  halo.addColorStop(0, color);
  halo.addColorStop(0.4, dark ? `hsla(${ember.hue}, 90%, 58%, ${alpha * 0.35})` : `hsla(${ember.hue}, 80%, 56%, ${alpha * 0.28})`);
  halo.addColorStop(1, "transparent");

  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(ember.x, ember.y, ember.size * 6, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = dark ? `rgba(255, 235, 200, ${Math.min(1, alpha + 0.15)})` : `rgba(255, 220, 180, ${alpha})`;
  ctx.beginPath();
  ctx.arc(ember.x, ember.y, ember.size, 0, Math.PI * 2);
  ctx.fill();
}

function paintSpark(ctx, spark, dark, time) {
  const wobble = Math.sin(spark.phase + time * spark.speed) * 12;
  const x = spark.x + wobble;
  const y = spark.y + Math.cos(spark.phase + time * spark.speed * 1.3) * 8;
  const alpha = dark ? 0.5 : 0.35;
  ctx.fillStyle = dark
    ? `rgba(220, 230, 255, ${alpha})`
    : `rgba(255, 255, 255, ${alpha + 0.1})`;
  ctx.beginPath();
  ctx.arc(x, y, spark.radius, 0, Math.PI * 2);
  ctx.fill();
}

function makeShootingStar(width, height) {
  // Enter from the upper right, streak toward the lower left.
  const startX = width + rand(0, 120);
  const startY = rand(-40, height * 0.35);
  const angle = rand(Math.PI * 0.85, Math.PI * 1.05); // roughly leftward-down
  const speed = rand(6, 10);
  return {
    x: startX,
    y: startY,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed * 0.6,
    age: 0,
    life: rand(1.1, 1.8),
    length: rand(160, 280)
  };
}

function paintShootingStar(ctx, star, dark) {
  const fade = Math.max(0, Math.min(1, 1 - star.age / star.life));
  const tailX = star.x - (star.vx / Math.hypot(star.vx, star.vy)) * star.length;
  const tailY = star.y - (star.vy / Math.hypot(star.vx, star.vy)) * star.length;
  const gradient = ctx.createLinearGradient(star.x, star.y, tailX, tailY);
  const headColor = dark ? "rgba(255, 240, 210, " : "rgba(255, 200, 140, ";
  gradient.addColorStop(0, `${headColor}${0.85 * fade})`);
  gradient.addColorStop(1, `${headColor}0)`);
  ctx.save();
  ctx.strokeStyle = gradient;
  ctx.lineWidth = 2.2;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(star.x, star.y);
  ctx.lineTo(tailX, tailY);
  ctx.stroke();

  // Little halo at the head
  const halo = ctx.createRadialGradient(star.x, star.y, 0, star.x, star.y, 6);
  halo.addColorStop(0, `rgba(255, 225, 170, ${0.85 * fade})`);
  halo.addColorStop(1, "rgba(255, 225, 170, 0)");
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(star.x, star.y, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function startAmbient() {
  const container = ensureContainer();
  const canvas = container.querySelector(".hearthboard-ambient-canvas");
  const ctx = canvas.getContext("2d", { alpha: true });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  let width = window.innerWidth;
  let height = window.innerHeight;
  let embers = [];
  let sparks = [];
  let shootingStars = [];
  let nextShootingStarAt = performance.now() + rand(12000, 24000);
  let pointer = { x: width / 2, y: height + 80, active: false, last: 0 };
  let lastFrame = performance.now();
  let running = true;
  let rafHandle = 0;

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    embers = Array.from({ length: EMBER_COUNT }, () => makeEmber(width, height));
    sparks = Array.from({ length: SPARK_COUNT }, () => makeSpark(width, height));
  }

  function step(now) {
    if (!running) {
      return;
    }

    const delta = Math.min(64, now - lastFrame);
    lastFrame = now;
    const dark = isDarkTheme();

    ctx.clearRect(0, 0, width, height);
    paintAurora(ctx, width, height, now);

    for (const spark of sparks) {
      paintSpark(ctx, spark, dark, now);
    }

    // Launch a shooting star at a random interval, then run any in flight.
    if (now >= nextShootingStarAt && shootingStars.length < 2) {
      shootingStars.push(makeShootingStar(width, height));
      nextShootingStarAt = now + rand(14000, 32000);
    }
    for (let i = shootingStars.length - 1; i >= 0; i -= 1) {
      const star = shootingStars[i];
      star.age += delta / 1000;
      star.x += star.vx * (delta / 16);
      star.y += star.vy * (delta / 16);
      paintShootingStar(ctx, star, dark);
      if (star.age > star.life || star.x < -200 || star.y > height + 100) {
        shootingStars.splice(i, 1);
      }
    }

    for (const ember of embers) {
      ember.age += delta / 1000;
      ember.twinkle += delta / 320;

      // Mouse interaction: gently push embers away from cursor.
      if (pointer.active) {
        const dx = ember.x - pointer.x;
        const dy = ember.y - pointer.y;
        const distance = Math.hypot(dx, dy);
        if (distance < 130) {
          const push = (130 - distance) / 130;
          ember.vx += (dx / (distance + 0.001)) * push * 0.06;
          ember.vy += (dy / (distance + 0.001)) * push * 0.06;
        }
      }

      ember.x += ember.vx * (delta / 16);
      ember.y += ember.vy * (delta / 16);

      // Sway sideways with a sine drift.
      ember.x += Math.sin(now * 0.0009 + ember.twinkle) * 0.18;

      paintEmber(ctx, ember, dark);

      const offTop = ember.y < -40;
      const expired = ember.age > ember.maxLife;
      const offSide = ember.x < -60 || ember.x > width + 60;
      if (offTop || expired || offSide) {
        Object.assign(ember, makeEmber(width, height));
        ember.age = 0;
      }
    }

    rafHandle = window.requestAnimationFrame(step);
  }

  function pause() {
    running = false;
    if (rafHandle) {
      cancelAnimationFrame(rafHandle);
      rafHandle = 0;
    }
  }

  function resume() {
    if (running) {
      return;
    }
    running = true;
    lastFrame = performance.now();
    rafHandle = window.requestAnimationFrame(step);
  }

  function handlePointer(event) {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.active = true;
    pointer.last = performance.now();
  }

  function handlePointerLeave() {
    pointer.active = false;
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      pause();
    } else {
      resume();
    }
  });

  // Pause the ambient canvas while the page is actively scrolling, resume
  // shortly after scrolling stops. Scrolling is when backdrop-filter +
  // gradient repaints compete for the compositor; silencing the canvas
  // frees the GPU to keep scroll smooth. Animations are fully intact when
  // the page is at rest — which is when users actually see them.
  let scrollResumeHandle = 0;
  const SCROLL_RESUME_DELAY_MS = 220;
  const onScroll = () => {
    if (running) {
      pause();
    }
    if (scrollResumeHandle) {
      clearTimeout(scrollResumeHandle);
    }
    scrollResumeHandle = window.setTimeout(() => {
      scrollResumeHandle = 0;
      if (!document.hidden) {
        resume();
      }
    }, SCROLL_RESUME_DELAY_MS);
  };
  window.addEventListener("scroll", onScroll, { passive: true, capture: true });

  window.addEventListener("resize", resize);
  window.addEventListener("pointermove", handlePointer, { passive: true });
  window.addEventListener("pointerleave", handlePointerLeave);
  window.addEventListener("blur", handlePointerLeave);

  resize();
  rafHandle = window.requestAnimationFrame(step);
}

function bindThemeReactiveGlow() {
  const cards = document.querySelectorAll(".card");
  if (!cards.length) {
    return;
  }

  // Only update the radial glow under the cursor — no tilt. Also throttled
  // via rAF so low-end laptops don't drop frames on every pointermove.
  let latestEvent = null;
  let pendingFrame = false;

  const applyGlow = () => {
    pendingFrame = false;
    if (!latestEvent) return;
    const event = latestEvent;

    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      if (
        event.clientX < rect.left - 40 ||
        event.clientX > rect.right + 40 ||
        event.clientY < rect.top - 40 ||
        event.clientY > rect.bottom + 40
      ) {
        card.style.removeProperty("--card-glow-x");
        card.style.removeProperty("--card-glow-y");
        continue;
      }

      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;
      card.style.setProperty("--card-glow-x", `${x * 100}%`);
      card.style.setProperty("--card-glow-y", `${y * 100}%`);
    }
  };

  const onMove = (event) => {
    latestEvent = event;
    if (!pendingFrame) {
      pendingFrame = true;
      window.requestAnimationFrame(applyGlow);
    }
  };

  window.addEventListener("pointermove", onMove, { passive: true });
}

function revealOnScroll() {
  if (typeof IntersectionObserver !== "function") {
    document.querySelectorAll(".card").forEach((card) => card.classList.add("is-revealed"));
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-revealed");
        observer.unobserve(entry.target);
      }
    }
  }, { threshold: 0.08 });

  document.querySelectorAll(".card, .calendar-cell, .stack > *, .summary-card").forEach((node) => {
    observer.observe(node);
  });
}

function watchThemeChanges() {
  // Bridges any theme-toggle into a CSS class hook so the ambient tweaks land
  // in lockstep with the page's color tokens.
  const apply = () => {
    document.body.classList.toggle("is-dark-ambient", isDarkTheme());
  };

  apply();

  const observer = new MutationObserver(apply);
  observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
}

function detectPerformanceMode() {
  const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const lowMemory = Number.isFinite(navigator.deviceMemory) && navigator.deviceMemory <= 4;
  const lowCpu = Number.isFinite(navigator.hardwareConcurrency) && navigator.hardwareConcurrency <= 4;
  const liteMode = reduceMotion || lowMemory || lowCpu;
  document.body.classList.toggle("is-ambient-lite", liteMode);
  document.body.classList.toggle("is-motion-reduced", reduceMotion);
  return { liteMode, reduceMotion };
}

function bindDialogBodyLock() {
  // Freeze page scroll and hide the page scrollbar whenever any <dialog.modal>
  // is open. This is the belt-and-suspenders fallback for browsers that lack
  // :has() — the CSS rule `html:has(dialog[open]){overflow:hidden}` handles
  // modern browsers; this keeps the experience consistent everywhere.
  const dialogs = document.querySelectorAll("dialog.modal");
  if (!dialogs.length) return;

  const refresh = () => {
    const anyOpen = Array.from(document.querySelectorAll("dialog.modal"))
      .some((d) => d.hasAttribute("open"));
    document.body.classList.toggle("has-modal-open", anyOpen);
  };

  const observer = new MutationObserver(refresh);
  for (const dialog of dialogs) {
    observer.observe(dialog, { attributes: true, attributeFilter: ["open"] });
  }
  refresh();
}

function bindViewerQuickClose() {
  // Clicking outside the image/video (on the dim backdrop) or on the media
  // itself closes the viewer, which feels more like a native lightbox.
  const viewer = document.querySelector("#viewer-modal");
  if (!viewer) return;

  // Close on clicks to the backdrop — i.e. clicks on the <dialog> itself
  // rather than on its form/content.
  viewer.addEventListener("click", (event) => {
    if (event.target === viewer) {
      viewer.close();
    }
  });

  // Close on clicking the image itself (tap to dismiss on touch, too).
  viewer.addEventListener("click", (event) => {
    const target = event.target;
    if (target && target.tagName === "IMG" && target.closest("#viewer-body")) {
      viewer.close();
    }
  });
}

function start() {
  watchThemeChanges();
  const { liteMode, reduceMotion } = detectPerformanceMode();

  if (!liteMode) {
    startAmbient();
  }
  if (!reduceMotion) {
    bindThemeReactiveGlow();
    revealOnScroll();
  } else {
    // Make cards visible immediately without the rise animation.
    document.querySelectorAll(".card, .calendar-cell, .summary-card")
      .forEach((node) => node.classList.add("is-revealed"));
  }
  bindDialogBodyLock();
  bindViewerQuickClose();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
