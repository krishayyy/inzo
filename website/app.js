/* Demo of the approval gate. Deliberately mirrors the real rule: a plan locks
   only when BOTH humans have approved the same version, so the demo shows your
   approval landing first and the peer's arriving second — never one click
   silently standing in for two people. */

const approve = document.querySelector("#approve");
const revoke = document.querySelector("#revoke");
const status = document.querySelector("#status");
const messages = document.querySelector("#messages");
const proposal = document.querySelector("#proposal");
const play = document.querySelector("#play-demo");
const reset = document.querySelector("#reset-demo");

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

let pending;

function note(text) {
  const el = document.createElement("article");
  el.className = "system";
  el.innerHTML = `<small>INZO · NOW</small><p>${text}</p>`;
  messages.append(el);
  return el;
}

function run() {
  if (approve.disabled) return;
  approve.disabled = true;
  approve.textContent = "You approved ✓";
  status.textContent = "1 of 2 approvals · waiting on your teammate";
  note("Your approval signed <code>plan v3</code> with your holder key.");

  // The peer's approval is a separate human on a separate machine.
  const delay = reducedMotion.matches ? 0 : 1100;
  pending = window.setTimeout(() => {
    status.textContent = "Plan locked · agents can start ✓";
    status.classList.add("approved");
    proposal.classList.add("locked");
    note("Teammate approved the same version. Starting the build with 2h 41m of runway.");
    revoke.hidden = false;
  }, delay);
}

// Shows the kill-switch: either human can revoke instantly, without the
// other side's cooperation, even after both approvals have landed.
function pull() {
  if (revoke.disabled) return;
  revoke.disabled = true;
  status.textContent = "Revoked · agent execution halted ✓";
  status.classList.remove("approved");
  status.classList.add("revoked");
  proposal.classList.remove("locked");
  proposal.classList.add("revoked");
  note("You revoked the teammate agent's credential. It can no longer read, write, or approve — even mid-task.");
}

function restore() {
  window.clearTimeout(pending);
  approve.disabled = false;
  approve.innerHTML = 'Approve plan <b aria-hidden="true">→</b>';
  revoke.hidden = true;
  revoke.disabled = false;
  status.textContent = "Awaiting human approval";
  status.classList.remove("approved", "revoked");
  proposal.classList.remove("locked", "revoked");
  messages.querySelectorAll(".system").forEach((el) => el.remove());
}

approve.addEventListener("click", run);
revoke.addEventListener("click", pull);
reset.addEventListener("click", restore);

play.addEventListener("click", () => {
  document.querySelector("#demo").scrollIntoView({
    behavior: reducedMotion.matches ? "auto" : "smooth",
    block: "center",
  });
  window.setTimeout(run, reducedMotion.matches ? 0 : 500);
});

// Scroll reveal: below-the-fold blocks fade + rise into view once, staggered
// within their group (feature cards, trust rows, runway tiles, quickstart
// steps). Skipped under reduced motion — those elements are just shown
// immediately, both here and via the CSS media-query fallback for no-JS.
const revealEls = document.querySelectorAll(".reveal");
if (reducedMotion.matches) {
  revealEls.forEach((el) => el.classList.add("in-view"));
} else {
  revealEls.forEach((el) => {
    const group = el.closest("[data-reveal-group]");
    const siblings = group ? Array.from(group.querySelectorAll(".reveal")) : [el];
    const index = siblings.indexOf(el);
    el.style.transitionDelay = `${Math.min(index, 5) * 80}ms`;
  });
  const revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("in-view");
        revealObserver.unobserve(entry.target);
      });
    },
    { threshold: 0.15, rootMargin: "0px 0px -60px 0px" },
  );
  revealEls.forEach((el) => revealObserver.observe(el));

  // Safety net: content must never stay invisible. If IntersectionObserver
  // is unavailable, misbehaves, or a browser quirk stops it from firing for
  // an element already on screen, force everything visible after a beat.
  window.setTimeout(() => {
    revealObserver.disconnect();
    revealEls.forEach((el) => el.classList.add("in-view"));
  }, 2500);
}

// The sticky header keeps its hairline and shadow hidden until the page has
// actually moved, so at rest it reads as part of the hero.
const headerBar = document.querySelector("[data-header]");
if (headerBar) {
  const syncHeader = () => headerBar.toggleAttribute("data-scrolled", window.scrollY > 8);
  syncHeader();
  window.addEventListener("scroll", syncHeader, { passive: true });
}

// Cursor tilt on the demo panel. Rotation is written to two custom properties
// and composed by CSS, so the resting angle lives in one place. Skipped
// entirely under reduced motion, and only bound for devices that actually
// hover — on touch there is no cursor to follow, and binding it there would
// leave the panel stuck at whatever angle the last tap produced.
const demoPanel = document.querySelector("#demo");
const canHover = window.matchMedia("(hover: hover) and (pointer: fine)");

if (demoPanel && !reducedMotion.matches && canHover.matches) {
  const MAX_TILT = 5; // degrees — enough to read as depth, not as a gimmick
  let frame;

  demoPanel.addEventListener("pointermove", (e) => {
    if (frame) return; // coalesce to one update per frame
    frame = requestAnimationFrame(() => {
      frame = null;
      const r = demoPanel.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      demoPanel.style.setProperty("--tilt-y", `${(px * MAX_TILT * 2).toFixed(2)}deg`);
      demoPanel.style.setProperty("--tilt-x", `${(-py * MAX_TILT * 2).toFixed(2)}deg`);
      demoPanel.setAttribute("data-tilt", "");
    });
  });

  demoPanel.addEventListener("pointerleave", () => {
    if (frame) { cancelAnimationFrame(frame); frame = null; }
    demoPanel.removeAttribute("data-tilt");
    demoPanel.style.removeProperty("--tilt-x");
    demoPanel.style.removeProperty("--tilt-y");
  });
}

// Spotlight-on-hover for the feature cards: a soft radial glow that tracks
// the pointer, driven by CSS custom properties set on pointermove.
document.querySelectorAll(".features article").forEach((card) => {
  card.addEventListener("pointermove", (e) => {
    const rect = card.getBoundingClientRect();
    card.style.setProperty("--x", `${e.clientX - rect.left}px`);
    card.style.setProperty("--y", `${e.clientY - rect.top}px`);
  });
});

// Logo marquee. The HTML authors one row; this clones it to four so the track
// always overflows the container and the -25% keyframe lands exactly one row
// along, making the loop seamless. Under reduced motion none of this runs and
// the single authored row just sits there.
const marquee = document.querySelector("[data-marquee]");
const marqueeTrack = marquee?.querySelector(".marquee-track");
const marqueeRow = marqueeTrack?.querySelector(".marquee-row");
const marqueeToggle = document.querySelector("#marquee-toggle");

if (marqueeTrack && marqueeRow && !reducedMotion.matches) {
  for (let i = 0; i < 3; i++) {
    const copy = marqueeRow.cloneNode(true);
    // Screen readers should hear the client list once, not four times.
    copy.setAttribute("aria-hidden", "true");
    marqueeTrack.append(copy);
  }
  marqueeTrack.dataset.ready = "true";

  if (marqueeToggle) {
    marqueeToggle.hidden = false;
    marqueeToggle.addEventListener("click", () => {
      const paused = marquee.toggleAttribute("data-paused");
      marqueeToggle.textContent = paused ? "Play" : "Pause";
      marqueeToggle.setAttribute("aria-pressed", String(paused));
    });
  }
}

// Add the real mark alongside each name once one has been dropped into
// brand/logos/. Probing with an off-DOM Image means a missing file costs
// nothing visible — no broken-image glyph, no layout shift, just the plain
// name staying put. Runs after cloning so the copies upgrade too; the browser
// serves them from cache, so it stays one request per logo.
//
// The name is kept rather than replaced: at 22px these marks are not all
// widely recognised on sight, and a row of unlabelled glyphs says less than
// a row of labelled ones. That makes the mark purely decorative, so its alt
// is always empty — the adjacent text is already the accessible name, and
// duplicating it would make screen readers announce each client twice.
document.querySelectorAll(".marquee-item[data-logo]").forEach((item) => {
  const src = `brand/logos/${item.dataset.logo}.svg`;
  const probe = new Image();
  probe.addEventListener("load", () => {
    const mark = document.createElement("img");
    mark.className = "logo-mark";
    mark.src = src;
    mark.alt = "";
    item.prepend(mark);
  });
  probe.src = src;
});

const copyQuickstart = document.querySelector("#copy-quickstart");
if (copyQuickstart) {
  const fullQuickstart = Array.from(document.querySelectorAll(".code-block code"))
    .map((el) => el.textContent)
    .join("\n\n");
  copyQuickstart.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(fullQuickstart);
      const original = copyQuickstart.innerHTML;
      copyQuickstart.textContent = "Copied ✓";
      window.setTimeout(() => {
        copyQuickstart.innerHTML = original;
      }, 1800);
    } catch {
      /* clipboard permission denied — the code blocks remain selectable/copyable by hand */
    }
  });
}

/* --- waitlist ----------------------------------------------------------- */

/* Netlify accepts form posts to any path on the site as long as the body
   carries `form-name`. Posting via fetch keeps people on the page; without
   JS the plain form POST still works and Netlify renders its own thank-you. */
const waitlist = document.querySelector(".waitlist");
if (waitlist) {
  const status = waitlist.querySelector(".waitlist-status");
  const submit = waitlist.querySelector("button[type='submit']");
  const email = waitlist.querySelector("#waitlist-email");

  /* Set here rather than in the markup: with JS off, the browser's own
     `required` / `type=email` checks are the only thing standing between a
     typo and a dead row, and they stay on. With JS on we take over, because
     a message under the field beats a bubble that vanishes on the next click
     and is invisible to a screen reader that isn't focused there. */
  waitlist.noValidate = true;

  /* Syntax only. Nothing here can tell you a real mailbox is behind the
     address — that takes a confirmation email — so the goal is narrow: catch
     the honest slips (a stray space, a missing dot, a half-typed domain)
     before they become a dead row in the dashboard, and never reject an
     address that might be real. */
  const EMAIL = /^[^\s@,;:<>()[\]\\"]+@[^\s@.]+(\.[^\s@.]+)+$/;

  /* Typos in the five domains that cover most signups. Suggest, never
     correct: someone really might own an address at a lookalike domain. */
  const COMMON = ["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com"];

  /* One substitution, insertion, deletion, or transposition away. */
  const isNearMiss = (a, b) => {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    let j = 0;
    let edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        i += 1;
        j += 1;
        continue;
      }
      if (++edits > 1) return false;
      if (a[i + 1] === b[j] && a[i] === b[j + 1]) {
        i += 2;
        j += 2;
      } else if (a.length > b.length) i += 1;
      else if (a.length < b.length) j += 1;
      else {
        i += 1;
        j += 1;
      }
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
  };

  const problemWith = (value) => {
    if (!value) return "Enter your email address so we know where to write.";
    if (/\s/.test(value)) return "That address has a space in it — check for a typo.";
    if (!value.includes("@")) return "That's missing an @ — try you@company.com.";
    if (!EMAIL.test(value)) return "That doesn't look like a complete address — try you@company.com.";
    /* The local part is capped at 64 octets by RFC 5321; the whole address at 254. */
    if (value.split("@")[0].length > 64) return "That address is longer than email allows.";
    return null;
  };

  const suggestionFor = (value) => {
    const domain = value.split("@")[1]?.toLowerCase();
    if (!domain || COMMON.includes(domain)) return null;
    return COMMON.find((known) => isNearMiss(domain, known)) ?? null;
  };

  const showProblem = (message) => {
    status.dataset.state = "error";
    status.textContent = message;
    email.setAttribute("aria-invalid", "true");
    email.focus();
  };

  const clearProblem = () => {
    email.removeAttribute("aria-invalid");
    if (status.dataset.state === "error") {
      status.dataset.state = "";
      status.textContent = "";
    }
  };

  /* Complain on the way out of the field, not on every keystroke — nobody
     wants to be told their address is wrong while they're still typing it. */
  email.addEventListener("input", clearProblem);
  email.addEventListener("blur", () => {
    const value = email.value.trim();
    if (!value) return;
    const problem = problemWith(value);
    if (problem) showProblem(problem);
  });

  waitlist.addEventListener("submit", async (event) => {
    event.preventDefault();

    /* Trailing whitespace from a copy-paste is the single most common way a
       good address arrives broken, and it is ours to fix, not theirs. */
    email.value = email.value.trim();

    const problem = problemWith(email.value);
    if (problem) {
      showProblem(problem);
      return;
    }

    const suggestion = suggestionFor(email.value);
    if (suggestion && email.dataset.confirmed !== email.value) {
      /* Second press of the same button sends it as typed. */
      email.dataset.confirmed = email.value;
      showProblem(`Did you mean @${suggestion}? Press again to send it as typed.`);
      return;
    }

    clearProblem();
    submit.disabled = true;
    status.dataset.state = "";
    status.textContent = "Sending…";

    try {
      const response = await fetch("/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(new FormData(waitlist)).toString(),
      });
      if (!response.ok) throw new Error(`relay responded ${response.status}`);
      waitlist.classList.add("is-done");
      status.dataset.state = "ok";
      status.textContent = "You're on the list ✓ We'll be in touch.";
    } catch {
      submit.disabled = false;
      status.dataset.state = "error";
      status.textContent = "That didn't send. Email inzodev.official@gmail.com and we'll add you by hand.";
    }
  });
}
