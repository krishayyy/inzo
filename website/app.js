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
