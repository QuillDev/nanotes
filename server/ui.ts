/** Minimal dark/pink web UI for passkey sign-in, device pairing, device tokens, and reading synced notes. */

export const WEB_UI_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>nanotes sync</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #09090c;
      --surface: #12131a;
      --border: rgba(255, 255, 255, 0.1);
      --text: #eceef5;
      --muted: #8b91a7;
      --pink: #f65c8e;
      --pink-bright: #ff7aa5;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      display: flex;
      justify-content: center;
      padding: 40px 20px;
    }
    main { width: 100%; max-width: 640px; }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 28px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    h1 { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.02em; }
    h1 .na { color: var(--pink); }
    h2 { margin: 28px 0 12px; font-size: 14px; font-weight: 650; color: var(--muted); }
    p { margin: 0 0 14px; color: var(--muted); font-size: 14px; line-height: 1.5; }
    button {
      height: 34px;
      padding: 0 14px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { border-color: rgba(255, 255, 255, 0.24); }
    button.primary {
      background: var(--pink);
      border-color: var(--pink);
      color: #09090c;
    }
    button.primary:hover { background: var(--pink-bright); border-color: var(--pink-bright); }
    button.ghost { background: transparent; color: var(--muted); }
    button.ghost:hover { color: var(--text); }
    button:disabled { opacity: 0.5; cursor: default; }
    input {
      width: 100%;
      height: 38px;
      padding: 0 12px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      font-size: 14px;
      outline: none;
    }
    input:focus { border-color: var(--pink); }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 0;
      border-top: 1px solid var(--border);
    }
    .row:first-of-type { border-top: 0; }
    .stack { display: grid; gap: 12px; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .muted { color: var(--muted); font-size: 13px; }
    .error { color: var(--pink-bright); font-size: 13px; margin-top: 8px; }
    .ok { color: #86efac; font-size: 13px; margin-top: 8px; }
    .code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 15px;
      letter-spacing: 0.08em;
      padding: 10px 14px;
      border-radius: 10px;
      background: var(--surface);
      border: 1px solid var(--border);
      word-break: break-all;
    }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      padding: 14px;
      border-radius: 10px;
      background: var(--surface);
      border: 1px solid var(--border);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
      line-height: 1.55;
      margin: 12px 0 0;
    }
    .noteBtn {
      background: none;
      border: 0;
      padding: 0;
      height: auto;
      color: var(--text);
      font-size: 14px;
      font-weight: 550;
      text-align: left;
      border-radius: 0;
    }
    .noteBtn:hover { color: var(--pink-bright); }
  </style>
</head>
<body>
  <main id="app"></main>
  <script type="module">
    const root = document.getElementById("app");
    let state = { signedIn: false, methods: { passkey: false, password: false }, devices: [], notes: [], selectedNote: null, newToken: null, message: "", error: "" };

    function bytes(text) {
      const base64 = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
      return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer;
    }

    function b64url(buffer) {
      return btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
    }

    async function api(path, opts = {}) {
      const res = await fetch(path, {
        ...opts,
        headers: { "content-type": "application/json", ...(opts.headers || {}) },
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data };
    }

    function route() {
      const hash = location.hash || "#/";
      const passkeyMatch = /^#\\/passkey\\/([^/]+)$/.exec(hash);
      if (passkeyMatch) return { kind: "passkey", token: decodeURIComponent(passkeyMatch[1]) };
      const pairMatch = /^#\\/pair\\/([^/]+)$/.exec(hash);
      if (pairMatch) return { kind: "pair", code: decodeURIComponent(pairMatch[1]).toUpperCase() };
      return { kind: "home" };
    }

    function el(tag, attrs = {}, ...children) {
      const node = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) {
        if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === "class") node.className = v;
        else if (v !== false && v !== undefined && v !== null) node.setAttribute(k, v === true ? "" : String(v));
      }
      for (const child of children.flat()) {
        if (child === null || child === undefined || child === false) continue;
        node.append(typeof child === "string" ? document.createTextNode(child) : child);
      }
      return node;
    }

    async function signInPasskey() {
      state.error = "";
      state.message = "";
      render();
      const started = await api("/api/passkeys/login/options", { method: "POST", body: "{}" });
      if (!started.ok) { state.error = started.data.error || "Passkey login unavailable"; return render(); }
      try {
        const cred = await navigator.credentials.get({
          publicKey: { ...started.data.publicKey, challenge: bytes(started.data.publicKey.challenge) },
        });
        const resp = cred.response;
        const finished = await api("/api/passkeys/login", {
          method: "POST",
          body: JSON.stringify({
            challengeId: started.data.challengeId,
            credential: {
              id: b64url(cred.rawId),
              clientDataJSON: b64url(resp.clientDataJSON),
              authenticatorData: b64url(resp.authenticatorData),
              signature: b64url(resp.signature),
            },
          }),
        });
        if (!finished.ok) { state.error = finished.data.error || "Sign in failed"; return render(); }
        await loadSession();
      } catch (err) {
        state.error = err?.name === "NotAllowedError" ? "Passkey prompt was cancelled" : (err?.message || "Passkey failed");
        render();
      }
    }

    async function registerPasskey(setupToken) {
      state.error = "";
      state.message = "";
      render();
      const started = await api("/api/passkeys/register/options", { method: "POST", body: JSON.stringify({ setup: setupToken }) });
      if (!started.ok) { state.error = started.data.error || "Setup link invalid or expired"; return render(); }
      try {
        const pk = started.data.publicKey;
        const cred = await navigator.credentials.create({
          publicKey: {
            ...pk,
            challenge: bytes(pk.challenge),
            user: { ...pk.user, id: bytes(pk.user.id) },
            excludeCredentials: (pk.excludeCredentials || []).map((c) => ({ ...c, id: bytes(c.id) })),
          },
        });
        const resp = cred.response;
        const finished = await api("/api/passkeys/register", {
          method: "POST",
          body: JSON.stringify({
            challengeId: started.data.challengeId,
            credential: {
              id: b64url(cred.rawId),
              clientDataJSON: b64url(resp.clientDataJSON),
              attestationObject: b64url(resp.attestationObject),
            },
          }),
        });
        if (!finished.ok) { state.error = finished.data.error || "Registration failed"; return render(); }
        location.hash = "#/";
        await loadSession();
      } catch (err) {
        state.error = err?.name === "NotAllowedError" ? "Passkey prompt was cancelled" : (err?.message || "Passkey failed");
        render();
      }
    }

    async function loadSession() {
      const methods = await api("/api/login/methods");
      if (methods.ok) state.methods = methods.data;
      const devices = await api("/api/devices");
      if (devices.ok) {
        state.signedIn = true;
        state.devices = devices.data.devices || [];
        const notes = await api("/api/notes");
        if (notes.ok) state.notes = notes.data.notes || [];
      } else {
        state.signedIn = false;
      }
      render();
    }

    function renderHeader() {
      return el("header", {},
        el("h1", {}, el("span", { class: "na" }, "na"), "notes"),
        state.signedIn
          ? el("button", {
              class: "ghost",
              onClick: async () => {
                await api("/api/logout", { method: "POST", body: "{}" });
                state.signedIn = false;
                state.selectedNote = null;
                state.newToken = null;
                render();
              },
            }, "Sign out")
          : null,
      );
    }

    function renderSignIn(subtitle) {
      let passwordValue = "";
      return el("div", { class: "stack" },
        el("p", {}, subtitle || "Sign in to manage synced devices and notes."),
        state.methods.passkey
          ? el("div", { class: "actions" }, el("button", { class: "primary", onClick: signInPasskey }, "Sign in with passkey"))
          : null,
        state.methods.password
          ? el("form", {
              class: "stack",
              onSubmit: async (event) => {
                event.preventDefault();
                state.error = "";
                const res = await api("/api/login", { method: "POST", body: JSON.stringify({ password: passwordValue }) });
                if (!res.ok) { state.error = res.data.error || "Sign in failed"; return render(); }
                await loadSession();
              },
            },
              el("input", { type: "password", placeholder: "Password", onInput: (e) => { passwordValue = e.target.value; } }),
              el("div", { class: "actions" }, el("button", { type: "submit", class: state.methods.passkey ? "" : "primary" }, "Sign in with password")),
            )
          : null,
        !state.methods.passkey && !state.methods.password
          ? el("p", {}, "No passkey registered yet. Run the setup-link command on the server or call passkey_setup_link over MCP.")
          : null,
        state.error ? el("div", { class: "error" }, state.error) : null,
      );
    }

    function render() {
      root.innerHTML = "";
      const current = route();
      root.append(renderHeader());

      if (current.kind === "passkey") {
        root.append(
          el("div", { class: "stack" },
            el("p", {}, "Register a passkey for this nanotes sync server."),
            el("div", { class: "actions" }, el("button", { class: "primary", onClick: () => registerPasskey(current.token) }, "Add passkey")),
            state.error ? el("div", { class: "error" }, state.error) : null,
          ),
        );
        return;
      }

      if (!state.signedIn) {
        root.append(renderSignIn(current.kind === "pair" ? "Sign in to approve device " + current.code + "." : undefined));
        return;
      }

      if (current.kind === "pair") {
        root.append(
          el("div", { class: "stack" },
            el("p", {}, "Approve desktop sync for this pairing code:"),
            el("div", { class: "code" }, current.code),
            el("div", { class: "actions" },
              el("button", {
                class: "primary",
                onClick: async () => {
                  state.error = "";
                  state.message = "";
                  const res = await api("/api/device/approve", { method: "POST", body: JSON.stringify({ code: current.code }) });
                  if (!res.ok) { state.error = res.data.error || "Could not approve device"; return render(); }
                  state.message = "Approved " + (res.data.device?.name || "device") + ". You can return to nanotes.";
                  location.hash = "#/";
                  await loadSession();
                },
              }, "Approve device"),
              el("button", { class: "ghost", onClick: () => { location.hash = "#/"; render(); } }, "Cancel"),
            ),
            state.error ? el("div", { class: "error" }, state.error) : null,
          ),
        );
        return;
      }

      if (state.message) root.append(el("div", { class: "ok" }, state.message));
      if (state.error) root.append(el("div", { class: "error" }, state.error));

      root.append(
        el("h2", {}, "Connected devices"),
        el("div", { class: "actions", style: "margin-bottom: 12px" },
          el("button", {
            onClick: async () => {
              const name = prompt("Device label", "Manual token");
              if (name === null) return;
              const res = await api("/api/devices", { method: "POST", body: JSON.stringify({ name }) });
              if (!res.ok) { state.error = res.data.error || "Could not create token"; return render(); }
              state.newToken = res.data.token;
              await loadSession();
            },
          }, "New sync token"),
          state.methods.passkey
            ? el("button", {
                class: "ghost",
                onClick: async () => {
                  const res = await api("/api/passkeys/setup-link", { method: "POST", body: "{}" });
                  if (!res.ok) { state.error = res.data.error || "Passkeys not configured"; return render(); }
                  state.message = "One-time passkey setup link: " + res.data.url;
                  render();
                },
              }, "Add another passkey")
            : null,
        ),
        state.newToken ? el("div", { class: "stack", style: "margin-bottom: 16px" },
          el("div", { class: "muted" }, "Copy this token now (shown once):"),
          el("div", { class: "code" }, state.newToken),
        ) : null,
        state.devices.length === 0
          ? el("p", {}, "No devices connected yet.")
          : el("div", {}, state.devices.map((device) =>
              el("div", { class: "row" },
                el("div", {},
                  el("div", {}, device.name),
                  el("div", { class: "muted" }, device.lastUsedAt ? "Last synced " + new Date(device.lastUsedAt).toLocaleString() : "Never synced"),
                ),
                el("button", {
                  class: "ghost",
                  onClick: async () => {
                    await api("/api/devices/" + encodeURIComponent(device.id), { method: "DELETE" });
                    await loadSession();
                  },
                }, "Revoke"),
              ),
            )),
      );

      root.append(
        el("h2", {}, "Synced notes"),
        state.notes.length === 0
          ? el("p", {}, "No synced notes yet.")
          : el("div", {}, state.notes.map((note) =>
              el("div", { class: "row" },
                el("button", {
                  class: "noteBtn",
                  onClick: async () => {
                    const res = await api("/api/notes/" + encodeURIComponent(note.id));
                    if (res.ok) { state.selectedNote = res.data; render(); }
                  },
                }, (note.pinned ? "★ " : "") + note.title),
                el("span", { class: "muted" }, note.path),
              ),
            )),
        state.selectedNote
          ? el("pre", {}, state.selectedNote.content || "")
          : null,
      );
    }

    window.addEventListener("hashchange", render);
    loadSession();
  </script>
</body>
</html>
`;
