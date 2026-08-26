/**
 * The whole front end: landing page, pairing screen, dashboard.
 *
 * Vanilla, no build step, served by the same Fastify process as the API. The
 * product's entire surface is "sign up, pair, pick countries, watch the log",
 * and that does not need a framework or a second deploy target.
 */

const $ = (sel, root = document) => root.querySelector(sel);
const app = $("#app");

const state = {
  token: localStorage.getItem("wf.token") || null,
  me: null,
  link: null,
  rules: [],
  activity: { events: [], summary: {} },
  pending: [],
  error: null,
  busy: false,
};

// ---------------------------------------------------------------- api

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";

  const response = await fetch(path, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    // A dead or rotated token should drop us back to the landing page rather
    // than leaving a dashboard on screen that cannot load anything.
    if (response.status === 401) signOut();
    const error = new Error(body.message || `request failed (${response.status})`);
    error.code = body.code || body.error;
    throw error;
  }
  return body;
}

function signOut() {
  localStorage.removeItem("wf.token");
  state.token = null;
  state.me = null;
  stopPolling();
}

// ---------------------------------------------------------------- rendering

function render() {
  if (state.token && !state.me) return renderLoading();
  if (!state.token) return renderLanding();
  if (!state.me.session || ["logged_out", "revoked"].includes(state.me.session.status)) {
    return renderConnect();
  }
  if (state.me.session.status !== "linked") return renderPairing();
  return renderDashboard();
}

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

function banner() {
  if (!state.error) return "";
  return `<div class="banner err">${esc(state.error)}</div>`;
}

function renderLoading() {
  app.innerHTML = `<div class="wrap"><p style="padding:80px 0">Loading…</p></div>`;
}

function renderLanding() {
  app.innerHTML = `
    <div class="wrap">
      <section class="hero">
        <h1>The numbers you never wanted to hear from, gone.</h1>
        <p class="lede">
          Link your WhatsApp, name the country codes and area codes you never want a
          conversation from, and they stop arriving. Everything else reaches you
          exactly as it does today.
        </p>
        ${banner()}
        <form class="signup" id="signup">
          <input type="email" name="email" placeholder="you@example.com" required
                 autocomplete="email" aria-label="Email address" />
          <button type="submit"${state.busy ? " disabled" : ""}>Get started</button>
        </form>
        <p class="fineprint">
          Nothing is filtered until you turn it on. New accounts start in watch-only
          mode, so you can see exactly what would have been caught before anything
          is.
        </p>
      </section>

      <section class="steps">
        <div class="step"><div class="n">1</div>
          <h3>Link your WhatsApp</h3>
          <p>Type an eight-character code into Linked Devices — the same screen you'd use for WhatsApp Web. No password, no QR to photograph.</p>
        </div>
        <div class="step"><div class="n">2</div>
          <h3>Choose your list</h3>
          <p>Pick whole countries by dialling code, or single area codes. Add an exception for the one number in that country you do talk to.</p>
        </div>
        <div class="step"><div class="n">3</div>
          <h3>Watch first</h3>
          <p>The log fills up with what <em>would</em> have been filtered. When it looks right, arm it.</p>
        </div>
        <div class="step"><div class="n">4</div>
          <h3>Then it's quiet</h3>
          <p>Matching conversations are removed as they arrive, and calls from those codes are declined.</p>
        </div>
      </section>
    </div>`;

  $("#signup").addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = new FormData(event.target).get("email");
    await guard(async () => {
      const body = await api("/v1/signup", { method: "POST", body: { email } });
      if (!body.token) {
        throw new Error("This deployment uses an external identity provider — sign in there.");
      }
      localStorage.setItem("wf.token", body.token);
      state.token = body.token;
      await refresh();
    });
  });
}

function shell(inner) {
  const status = state.me?.session?.status;
  const armed = state.me?.settings?.armed;
  const pill =
    status === "linked" && armed
      ? `<span class="pill live"><i class="dot"></i>Filtering</span>`
      : status === "linked"
        ? `<span class="pill warn"><i class="dot"></i>Watching only</span>`
        : `<span class="pill off"><i class="dot"></i>Not linked</span>`;

  return `
    <header class="bar"><div class="wrap">
      <div class="brand">Quiet<span>Numbers</span></div>
      ${pill}
      <button class="ghost small" id="signout">Sign out</button>
    </div></header>
    <main><div class="wrap">${banner()}${inner}</div></main>`;
}

function renderConnect() {
  const previous = state.me.session;
  app.innerHTML = shell(`
    <div class="card narrow">
      <h2>Link your WhatsApp</h2>
      <p class="sub">Enter the number this account uses, with its country code.</p>
      ${
        previous?.status === "logged_out"
          ? `<div class="banner warn">WhatsApp ended the link${
              previous.last_disconnect_reason ? ` (${esc(previous.last_disconnect_reason)})` : ""
            }. Pair again to carry on.</div>`
          : ""
      }
      <form class="signup" id="link">
        <input type="tel" name="phone" placeholder="+1 917 555 0123" required
               autocomplete="tel" aria-label="Your WhatsApp number" />
        <button type="submit"${state.busy ? " disabled" : ""}>Send me a code</button>
      </form>
      <p class="fineprint">
        This links a device to your WhatsApp, the same way WhatsApp Web does. You can
        remove it at any time from Linked Devices on your phone, or from here.
      </p>
    </div>`);

  bindShell();
  $("#link").addEventListener("submit", async (event) => {
    event.preventDefault();
    const phone = new FormData(event.target).get("phone");
    await guard(async () => {
      await api("/v1/link", { method: "POST", body: { phone } });
      await refresh();
      startPolling();
    });
  });
}

function renderPairing() {
  const code = state.link?.pairing_code;
  app.innerHTML = shell(`
    <div class="card narrow">
      <h2>Type this into WhatsApp</h2>
      <p class="sub">Pairing ${esc(state.me.session.phone_e164 ? `+${state.me.session.phone_e164}` : "")}</p>
      <div class="code${code ? "" : " pending"}">${
        code ? esc(code) : "Asking WhatsApp for a code…"
      }</div>
      <ol class="howto">
        <li>Open WhatsApp on your phone.</li>
        <li>Settings → <strong>Linked Devices</strong> → <strong>Link a device</strong>.</li>
        <li>Tap <strong>Link with phone number instead</strong>.</li>
        <li>Type the code above.</li>
      </ol>
      <p class="fineprint">Codes expire after a few minutes. This page will move on by itself once the link completes.</p>
      <div class="row" style="margin-top:12px">
        <button class="ghost small" id="restart">Start over</button>
      </div>
    </div>`);

  bindShell();
  $("#restart").addEventListener("click", async () => {
    await guard(async () => {
      await api("/v1/link", { method: "DELETE" });
      await refresh();
    });
  });
  startPolling();
}

const DECISION_LABEL = {
  blocked: "Removed",
  would_block: "Would remove",
  allowed: "Allowed by exception",
  no_match: "No rule matched",
  skipped_group: "Group, skipped",
  skipped_known: "Saved contact, skipped",
  unresolved_jid: "No number to read",
  error: "Failed",
};

function renderDashboard() {
  const s = state.me.settings;
  const summary = state.activity.summary || {};
  const blocked = summary.blocked || 0;
  const would = summary.would_block || 0;

  app.innerHTML = shell(`
    ${
      s.armed
        ? ""
        : `<div class="banner warn">
             <strong>Watch-only.</strong> Rules are being evaluated and logged, but no
             conversation has been touched. Arm the filter below when the log looks right.
           </div>`
    }

    <div class="card">
      <div class="spread">
        <div>
          <h2>${s.armed ? "Filtering" : "Watching"}</h2>
          <p class="sub" style="margin:0">
            Linked to +${esc(state.me.session.phone_e164)}${
              state.me.session.last_connected_at
                ? ` · last seen ${relative(state.me.session.last_connected_at)}`
                : ""
            }
          </p>
        </div>
        <button id="arm" class="${s.armed ? "ghost" : ""}"${state.busy ? " disabled" : ""}>
          ${s.armed ? "Disarm" : "Arm the filter"}
        </button>
      </div>
      <div class="stats" style="margin-top:16px">
        <div class="stat"><b>${blocked}</b><span>removed this week</span></div>
        <div class="stat"><b>${would}</b><span>would have been</span></div>
        <div class="stat"><b>${state.rules.filter((r) => r.enabled && r.kind === "block").length}</b><span>block rules</span></div>
        <div class="stat"><b>${state.rules.filter((r) => r.enabled && r.kind === "allow").length}</b><span>exceptions</span></div>
      </div>
    </div>

    ${
      state.pending.length
        ? `<div class="card">
             <h2>About to happen</h2>
             <p class="sub">Held for the delay you set. Cancel anything here and it will not happen.</p>
             <ul class="pending">${state.pending
               .map(
                 (p) => `<li>
                   <span class="prefix">${esc(displayJid(p.remote_jid))}</span>
                   <span class="rule-name">${esc(p.action.replace(/_/g, " "))} ${relative(p.due_at)}</span>
                   <button class="ghost small" data-cancel="${esc(p.id)}">Cancel</button>
                 </li>`,
               )
               .join("")}</ul>
           </div>`
        : ""
    }

    <div class="card">
      <div class="spread">
        <div><h2>Rules</h2><p class="sub" style="margin:0">Longest match wins, so an exception is just a longer prefix.</p></div>
        <div class="row">
          <button class="ghost" id="pick">Browse codes</button>
        </div>
      </div>
      <form id="addrule" style="margin-top:14px">
        <div class="signup" style="margin:0">
          <input type="text" name="prefix" placeholder="+234, or 917" required aria-label="Dialling prefix" />
          <select name="kind" aria-label="Rule type">
            <option value="block">Block</option>
            <option value="allow">Allow (exception)</option>
          </select>
          <button type="submit"${state.busy ? " disabled" : ""}>Add</button>
        </div>
        <label class="check" style="padding:6px 0 0">
          <input type="checkbox" name="area_code" />
          <span><span class="t">Three digits above is a US/Canada area code</span>
            <span class="d">Turns 917 into +1&nbsp;917. Leave off and 917 is read as a country prefix.</span></span>
        </label>
      </form>
      ${
        state.rules.length
          ? `<ul class="rules">${state.rules.map(ruleRow).join("")}</ul>`
          : `<p class="empty">No rules yet. Add a country code, or browse the list.</p>`
      }
    </div>

    <div class="card">
      <h2>Settings</h2>
      <div class="spread" style="align-items:flex-start;gap:24px">
        <div style="flex:1 1 240px">
          <label class="check">
            <input type="checkbox" id="set-groups" ${s.apply_to_groups ? "checked" : ""} />
            <span><span class="t">Apply inside groups</span>
              <span class="d">Judges the individual sender, not the group.</span></span>
          </label>
          <label class="check">
            <input type="checkbox" id="set-known" ${s.apply_to_known_contacts ? "checked" : ""} />
            <span><span class="t">Apply to saved contacts</span>
              <span class="d">Off by default — someone in your address book is someone you chose to know.</span></span>
          </label>
          <label class="check">
            <input type="checkbox" id="set-calls" ${s.reject_calls ? "checked" : ""} />
            <span><span class="t">Decline calls from blocked codes</span>
              <span class="d">Calls are declined immediately; there is no delay to hold them for.</span></span>
          </label>
        </div>
        <div style="flex:1 1 240px">
          <h3>What happens on a match</h3>
          <select id="set-action" aria-label="Action on match">
            ${[
              ["delete", "Delete the conversation"],
              ["block_and_delete", "Block the sender, then delete"],
              ["archive", "Archive and mute (reversible)"],
              ["log_only", "Log only, change nothing"],
            ]
              .map(
                ([value, label]) =>
                  `<option value="${value}"${s.action === value ? " selected" : ""}>${label}</option>`,
              )
              .join("")}
          </select>
          <h3 style="margin-top:16px">Hold deletes for</h3>
          <div class="row">
            <input type="number" id="set-delay" min="0" max="86400" step="30"
                   value="${s.delete_delay_seconds}" style="width:110px" aria-label="Delete delay in seconds" />
            <span class="d" style="color:var(--ink-3);font-size:0.84rem">seconds before the delete lands</span>
          </div>
          <p class="fineprint" style="margin-top:10px">
            Deleting a WhatsApp conversation cannot be undone. The hold is your window
            to spot a rule that matched someone you know.
          </p>
        </div>
      </div>
      <div class="row" style="margin-top:8px">
        <button class="ghost small" id="unlink">Unlink this WhatsApp</button>
      </div>
    </div>

    <div class="card">
      <h2>Activity</h2>
      <p class="sub">Every message the filter looked at. Content is never recorded — only the number and the decision.</p>
      ${
        state.activity.events.length
          ? `<ul class="events">${state.activity.events.slice(0, 60).map(eventRow).join("")}</ul>`
          : `<p class="empty">Nothing yet. Activity appears here as messages arrive.</p>`
      }
    </div>

    ${pickerMarkup()}`);

  bindShell();
  bindDashboard();
  startPolling();
}

function ruleRow(rule) {
  return `<li>
    <span class="prefix">+${esc(rule.prefix)}</span>
    <span class="rule-name">${esc(rule.label || "Custom prefix")}
      <small>matches every number starting +${esc(rule.prefix)}</small></span>
    <span class="tag ${rule.kind}">${rule.kind}</span>
    ${rule.enabled ? "" : `<span class="tag off">off</span>`}
    <button class="ghost small" data-toggle="${esc(rule.id)}" data-enabled="${rule.enabled}">
      ${rule.enabled ? "Disable" : "Enable"}</button>
    <button class="ghost small" data-delete="${esc(rule.id)}">Remove</button>
  </li>`;
}

function eventRow(event) {
  return `<li>
    <time datetime="${esc(event.occurred_at)}">${relative(event.occurred_at)}</time>
    <span class="who">${esc(
      event.phone_e164 ? `+${event.phone_e164}` : displayJid(event.remote_jid),
    )}${event.matched_prefix ? ` <span style="color:var(--ink-3)">· +${esc(event.matched_prefix)}</span>` : ""}</span>
    <span>${esc(DECISION_LABEL[event.decision] || event.decision)}</span>
  </li>`;
}

const displayJid = (jid) => String(jid).split("@")[0];

function relative(iso) {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  const future = seconds < 0;
  const n = Math.abs(seconds);
  const say = (value, unit) =>
    future ? `in ${value} ${unit}${value === 1 ? "" : "s"}` : `${value} ${unit}${value === 1 ? "" : "s"} ago`;
  if (n < 45) return future ? "in a moment" : "just now";
  if (n < 3600) return say(Math.round(n / 60), "min");
  if (n < 86400) return say(Math.round(n / 3600), "hour");
  return say(Math.round(n / 86400), "day");
}

// ---------------------------------------------------------------- picker

function pickerMarkup() {
  return `
    <dialog id="picker">
      <div class="head">
        <h2 style="margin:0">Browse dialling codes</h2>
        <div class="tabs">
          <button data-kind="country" aria-pressed="true">Countries</button>
          <button data-kind="nanp_area" aria-pressed="false">US &amp; Canada area codes</button>
        </div>
        <input type="text" id="picker-search" placeholder="Search by name or digits"
               style="width:100%;margin-top:10px" aria-label="Search dialling codes" />
      </div>
      <div class="body" id="picker-list"><p class="empty">Loading…</p></div>
      <div class="foot">
        <button class="ghost" id="picker-close">Cancel</button>
        <button id="picker-add">Block selected</button>
      </div>
    </dialog>`;
}

function bindPicker() {
  const dialog = $("#picker");
  const list = $("#picker-list");
  const search = $("#picker-search");
  let kind = "country";
  const chosen = new Set();

  async function load() {
    const params = new URLSearchParams({ kind });
    if (search.value.trim()) params.set("q", search.value.trim());
    const body = await api(`/v1/dial-prefixes?${params}`);
    const have = new Set(state.rules.map((r) => r.prefix));
    list.innerHTML = body.prefixes.length
      ? body.prefixes
          .map(
            (p) => `<label class="pick">
              <input type="checkbox" value="${esc(p.prefix)}"
                     ${have.has(p.prefix) ? "disabled" : ""} ${chosen.has(p.prefix) ? "checked" : ""} />
              <span class="prefix">+${esc(p.prefix)}</span>
              <span>${esc(p.name)}${have.has(p.prefix) ? " · already added" : ""}</span>
              <span class="region">${esc(p.region || "")}</span>
            </label>`,
          )
          .join("")
      : `<p class="empty">Nothing matches that.</p>`;
  }

  list.addEventListener("change", (event) => {
    const input = event.target;
    if (input.checked) chosen.add(input.value);
    else chosen.delete(input.value);
  });

  let timer;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => void load().catch(showError), 180);
  });

  for (const tab of dialog.querySelectorAll(".tabs button")) {
    tab.addEventListener("click", () => {
      kind = tab.dataset.kind;
      for (const other of dialog.querySelectorAll(".tabs button")) {
        other.setAttribute("aria-pressed", String(other === tab));
      }
      void load().catch(showError);
    });
  }

  $("#picker-close").addEventListener("click", () => dialog.close());
  $("#picker-add").addEventListener("click", async () => {
    if (chosen.size === 0) return dialog.close();
    await guard(async () => {
      // Prefixes come from the picker already in full dialled form, so
      // area_code stays false — '1917' must not become '11917'.
      await api("/v1/rules/bulk", {
        method: "POST",
        body: { prefixes: [...chosen], kind: "block", area_code: false },
      });
      dialog.close();
      await refresh();
    });
  });

  $("#pick").addEventListener("click", () => {
    chosen.clear();
    dialog.showModal();
    void load().catch(showError);
  });
}

// ---------------------------------------------------------------- events

function bindShell() {
  $("#signout")?.addEventListener("click", () => {
    signOut();
    render();
  });
}

function bindDashboard() {
  bindPicker();

  $("#arm").addEventListener("click", async () => {
    const arming = !state.me.settings.armed;
    if (arming && !confirmArming()) return;
    await guard(async () => {
      await api("/v1/settings", { method: "PATCH", body: { armed: arming } });
      await refresh();
    });
  });

  $("#addrule").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    await guard(async () => {
      await api("/v1/rules", {
        method: "POST",
        body: {
          prefix: form.get("prefix"),
          kind: form.get("kind"),
          area_code: form.get("area_code") === "on",
        },
      });
      await refresh();
    });
  });

  for (const button of app.querySelectorAll("[data-delete]")) {
    button.addEventListener("click", () =>
      guard(async () => {
        await api(`/v1/rules/${button.dataset.delete}`, { method: "DELETE" });
        await refresh();
      }),
    );
  }

  for (const button of app.querySelectorAll("[data-toggle]")) {
    button.addEventListener("click", () =>
      guard(async () => {
        await api(`/v1/rules/${button.dataset.toggle}`, {
          method: "PATCH",
          body: { enabled: button.dataset.enabled !== "true" },
        });
        await refresh();
      }),
    );
  }

  for (const button of app.querySelectorAll("[data-cancel]")) {
    button.addEventListener("click", () =>
      guard(async () => {
        await api(`/v1/pending/${button.dataset.cancel}`, { method: "DELETE" });
        await refresh();
      }),
    );
  }

  const patch = (body) => guard(async () => {
    await api("/v1/settings", { method: "PATCH", body });
    await refresh();
  });

  $("#set-groups").addEventListener("change", (e) => patch({ apply_to_groups: e.target.checked }));
  $("#set-known").addEventListener("change", (e) => patch({ apply_to_known_contacts: e.target.checked }));
  $("#set-calls").addEventListener("change", (e) => patch({ reject_calls: e.target.checked }));
  $("#set-action").addEventListener("change", (e) => patch({ action: e.target.value }));
  $("#set-delay").addEventListener("change", (e) =>
    patch({ delete_delay_seconds: Number(e.target.value) }),
  );

  $("#unlink").addEventListener("click", () => {
    if (!confirm("Unlink this WhatsApp? Filtering stops and you'll need to pair again.")) return;
    return guard(async () => {
      await api("/v1/link", { method: "DELETE" });
      await refresh();
    });
  });
}

/**
 * The one confirmation in the product. Arming is the moment an irreversible
 * action becomes possible, and it names what will happen rather than asking
 * "are you sure?".
 */
function confirmArming() {
  const s = state.me.settings;
  const count = state.rules.filter((r) => r.enabled && r.kind === "block").length;
  const what =
    s.action === "delete" || s.action === "block_and_delete"
      ? "Matching conversations will be DELETED from your phone. WhatsApp has no undo for this."
      : s.action === "archive"
        ? "Matching conversations will be archived and muted. This is reversible."
        : "Nothing will be changed — the action is still set to log only.";
  return confirm(
    `Arm the filter?\n\n${count} block rule${count === 1 ? "" : "s"} are active.\n${what}`,
  );
}

function showError(error) {
  state.error = error.message;
  render();
}

async function guard(fn) {
  state.busy = true;
  state.error = null;
  try {
    await fn();
  } catch (error) {
    state.error = error.message;
  } finally {
    state.busy = false;
    render();
  }
}

// ---------------------------------------------------------------- polling

let poll;

/**
 * The pairing screen needs a code that arrives out of band, and the dashboard
 * needs activity that arrives whenever someone messages. Both are slow-moving
 * enough that polling beats a websocket for a service this size.
 */
function startPolling() {
  stopPolling();
  const linked = state.me?.session?.status === "linked";
  poll = setInterval(() => void refresh(true).catch(() => {}), linked ? 15000 : 3000);
}

function stopPolling() {
  if (poll) clearInterval(poll);
  poll = undefined;
}

async function refresh(quiet = false) {
  if (!state.token) return render();
  const previous = JSON.stringify([state.me, state.link, state.rules, state.activity, state.pending]);

  state.me = await api("/v1/me");
  if (state.me.session && state.me.session.status !== "linked") {
    state.link = await api("/v1/link");
  } else {
    state.link = null;
  }
  if (state.me.session?.status === "linked") {
    const [rules, activity, pending] = await Promise.all([
      api("/v1/rules"),
      api("/v1/activity?limit=60"),
      api("/v1/pending"),
    ]);
    state.rules = rules.rules;
    state.activity = activity;
    state.pending = pending.pending;
  }

  // A background poll must not steal focus from a half-typed prefix, so an
  // unchanged payload does not re-render.
  const next = JSON.stringify([state.me, state.link, state.rules, state.activity, state.pending]);
  if (quiet && next === previous) return;
  render();
}

refresh().catch((error) => {
  state.error = error.message;
  render();
});
