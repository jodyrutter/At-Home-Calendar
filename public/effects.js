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

function startAmbient() {
  const container = ensureContainer();
  const canvas = container.querySelector(".hearthboard-ambient-canvas");
  const ctx = canvas.getContext("2d", { alpha: true });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  let width = window.innerWidth;
  let height = window.innerHeight;
  let embers = [];
  let sparks = [];
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

  window.addEventListener("resize", resize);
  window.addEventListener("pointermove", handlePointer, { passive: true });
  window.addEventListener("pointerleave", handlePointerLeave);
  window.addEventListener("blur", handlePointerLeave);

  resize();
  rafHandle = window.requestAnimationFrame(step);
}

function bindThemeReactiveTilt() {
  const cards = document.querySelectorAll(".card");
  if (!cards.length) {
    return;
  }

  // Subtle parallax on cards that follows the cursor.
  const onMove = (event) => {
    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      if (
        event.clientX < rect.left - 80 ||
        event.clientX > rect.right + 80 ||
        event.clientY < rect.top - 80 ||
        event.clientY > rect.bottom + 80
      ) {
        card.style.removeProperty("--card-tilt-x");
        card.style.removeProperty("--card-tilt-y");
        card.style.removeProperty("--card-glow-x");
        card.style.removeProperty("--card-glow-y");
        continue;
      }

      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;
      card.style.setProperty("--card-tilt-x", `${(0.5 - y) * 4}deg`);
      card.style.setProperty("--card-tilt-y", `${(x - 0.5) * 4}deg`);
      card.style.setProperty("--card-glow-x", `${x * 100}%`);
      card.style.setProperty("--card-glow-y", `${y * 100}%`);
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

function start() {
  watchThemeChanges();
  startAmbient();
  bindThemeReactiveTilt();
  revealOnScroll();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
