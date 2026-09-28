// Notifications and install, as the PWA asks for them (T7-5; screen 18 §6).
// No window.alert anywhere: every outcome is a line on the page, in the place
// the owner was looking.
//
// - **Ask in context**, the first time something reaches Needs You — never on
//   first launch. The ask sits at the top of Needs You while something waits
//   there, until it is answered: Turn On, or Not Now (remembered on this
//   device). The permission prompt runs only from that tap.
// - **iPhone and iPad** allow web push only from the installed Home Screen
//   app, so in a Safari tab the ask becomes the way to install instead.
// - **Install**: on iPhone a three-step sheet (Share → Add to Home Screen →
//   open it), because Safari has no install prompt; Chrome and Edge use their
//   own prompt, offered once from More.
//
// What a notification SAYS is the service worker's (sw.js): type and title,
// never a secret. This file only subscribes.
//
// The decisions are pure and exported, so a test drives them with a device
// and a count; `mountNotify` wires them to the DOM.

/** localStorage: "later" once Not Now is tapped — a per-device convenience, never state that must persist. */
export const ASK_KEY = "metistry.push.ask";
/** localStorage: "yes" once the browser's own install prompt has been offered from More. */
export const INSTALL_KEY = "metistry.install.offered";

/** The ask's words. */
export const ASK_TEXT = "Get a notification when something needs you? Only the type and title are shown.";
export const ASK_INSTALL_TEXT = "Get a notification when something needs you? On this device that takes the Home Screen app.";

/** What turning notifications on came to, said on the page. */
export const PUSH_WORDS = {
  on: "Notifications are on for this device.",
  off: "Notifications are off for this device.",
  denied: "Notifications are blocked for Metistry. Allow them in this browser's settings, then turn them on here.",
  dismissed: "Notifications stay off. You can turn them on in Settings.",
  unsupported: "This browser can't receive notifications.",
  install: "Notifications need the Home Screen app on this device. Install Metistry, open it from the Home Screen, and turn them on there.",
  absent: "This Metistry has no push keys configured, so it can't send notifications.",
  failed: "Notifications couldn't be turned on. Try again.",
};

/** What a test notification came to. */
export const TEST_WORDS = {
  sent: "A test notification is on its way.",
  no_subscription: "This device isn't subscribed. Turn notifications on first.",
  dead: "This device's subscription had expired and was removed. Turn notifications on again.",
  absent: PUSH_WORDS.absent,
  failed: "The test notification couldn't be sent. Try again.",
};

/**
 * The device, as far as push and install care. `ios` is "iPhone" or "iPad"
 * (an iPad asking for the desktop site reports a touch Mac), else null.
 */
export function deviceOf(win) {
  const nav = win.navigator ?? {};
  const ua = String(nav.userAgent ?? "");
  const touchMac = /Macintosh/.test(ua) && nav.platform === "MacIntel" && nav.maxTouchPoints > 1; // an iPad's desktop-site UA
  const ios = /iPhone|iPod/.test(ua) ? "iPhone" : /iPad/.test(ua) || touchMac ? "iPad" : null;
  const standalone = Boolean(win.matchMedia?.("(display-mode: standalone)").matches) || nav.standalone === true;
  const pushable = "Notification" in win && "PushManager" in win && "serviceWorker" in nav;
  return { ios, standalone, pushable, permission: pushable ? win.Notification.permission : "unsupported" };
}

/**
 * What the top of Needs You shows: nothing, the ask, or the way to install.
 * Nothing until something waits there (never on first launch), nothing after
 * Not Now, nothing where push cannot work or is already on.
 * `server` is "absent" when the console has no push keys; `subscribed` is
 * whether this device holds a subscription.
 */
export function askFor({ waiting, device, later, server, subscribed }) {
  if (!(Number(waiting) > 0) || later || server === "absent") return "none";
  if (device.ios && !device.standalone) return "install";
  if (!device.pushable || device.permission === "denied") return "none";
  if (device.permission === "granted" && subscribed) return "none";
  return "ask";
}

/** More's install row: the iPhone sheet, the browser's own prompt (once), or none. */
export function installOffer({ device, deferred, offered }) {
  if (device.standalone) return "none";
  if (device.ios) return "ios";
  return deferred && !offered ? "prompt" : "none";
}

/** Settings' line for this device, before anything is tapped. */
export function pushState({ device, server, subscribed }) {
  if (server === "absent") return "absent";
  if (device.ios && !device.standalone) return "install";
  if (!device.pushable) return "unsupported";
  if (device.permission === "denied") return "denied";
  return device.permission === "granted" && subscribed ? "on" : "off";
}

function stored(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function store(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private window: the ask may come back */ }
}

/**
 * Mount the ask (top of #triage), the install row (More) and sheet (#install),
 * and Settings' two buttons. `ctx` is the shell's: `$`, `api`, `show`.
 * Returns `needs(n)` — the shell calls it with each new Needs You count — and
 * `settings()`, which Settings' load calls.
 */
export function mountNotify({ $, api, show }) {
  let waiting = 0;
  let server = null; // null until the console has said whether it has push keys
  let deferred = null; // Chrome and Edge's install prompt, held until More offers it

  async function subscription() {
    try {
      const reg = await navigator.serviceWorker?.getRegistration("/");
      return (await reg?.pushManager?.getSubscription()) ?? null;
    } catch { return null; }
  }

  async function serverState() {
    if (server === null) {
      try {
        const body = await (await api("/api/push/vapid-key")).json();
        server = body.push === "absent" ? "absent" : "present";
      } catch { /* unknown: asked again next time */ }
    }
    return server;
  }

  async function paintAsk() {
    const device = deviceOf(window);
    const later = stored(ASK_KEY) === "later";
    // the cheap answer first: nothing waits, or Not Now — no request is made
    if (askFor({ waiting, device, later, server, subscribed: false }) === "none") { $("push-ask").hidden = true; return; }
    const mode = askFor({ waiting, device, later, server: await serverState(), subscribed: (await subscription()) !== null });
    $("push-ask").hidden = mode === "none";
    $("push-ask-text").textContent = mode === "install" ? ASK_INSTALL_TEXT : ASK_TEXT;
    $("push-ask-on").hidden = mode !== "ask";
    $("push-ask-install").hidden = mode !== "install";
  }

  /**
   * Turn notifications on for this device. `Notification.requestPermission`
   * runs first, inside the tap: a prompt asked for after an await is one
   * Safari refuses. Returns a PUSH_WORDS key.
   */
  async function enable() {
    const device = deviceOf(window);
    if (device.ios && !device.standalone) return "install";
    if (!device.pushable) return "unsupported";
    try {
      const permission = await Notification.requestPermission();
      if (permission === "denied") return "denied";
      if (permission !== "granted") return "dismissed";
      const reg = await navigator.serviceWorker.register("/sw.js"); // explicit; .ready can hang
      const res = await api("/api/push/vapid-key");
      const { key, push } = await res.json();
      if (push === "absent") { server = "absent"; return "absent"; }
      if (!res.ok || typeof key !== "string") return "failed";
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const saved = await api("/api/push/subscribe", { method: "POST", body: JSON.stringify({ subscription: sub }) });
      return saved.ok ? "on" : "failed";
    } catch {
      return "failed";
    }
  }

  $("push-ask-on").onclick = async () => {
    const outcome = await enable();
    if (outcome === "dismissed") store(ASK_KEY, "later"); // the prompt was closed: that is a Not Now
    $("push-ask-status").textContent = PUSH_WORDS[outcome];
    await paintAsk();
  };
  $("push-ask-later").onclick = () => {
    store(ASK_KEY, "later");
    $("push-ask-status").textContent = PUSH_WORDS.dismissed;
    paintAsk();
  };
  $("push-ask-install").onclick = () => show("install");

  // ----- install -----
  function paintInstall() {
    const device = deviceOf(window);
    const mode = installOffer({ device, deferred: deferred !== null, offered: stored(INSTALL_KEY) === "yes" });
    $("install-group").hidden = mode === "none";
    $("install-label").textContent = mode === "ios" ? `Install on ${device.ios}` : "Install Metistry";
    $("install-row").setAttribute("aria-haspopup", mode === "ios" ? "dialog" : "false");
  }
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // offered from More, once — not on first launch
    deferred = e;
    paintInstall();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    store(INSTALL_KEY, "yes");
    paintInstall();
  });
  $("install-row").onclick = async () => {
    const device = deviceOf(window);
    const mode = installOffer({ device, deferred: deferred !== null, offered: stored(INSTALL_KEY) === "yes" });
    if (mode === "ios") return show("install", { title: `Install on ${device.ios}` });
    if (mode !== "prompt") return;
    const prompt = deferred;
    deferred = null;
    store(INSTALL_KEY, "yes"); // once, whatever the answer
    paintInstall();
    try { await prompt.prompt(); } catch { /* the browser withdrew it */ }
  };
  paintInstall();

  // ----- Settings -----
  async function settings() {
    const device = deviceOf(window);
    const state = pushState({ device, server: await serverState(), subscribed: (await subscription()) !== null });
    $("push-status").textContent = PUSH_WORDS[state];
    $("push-enable").hidden = state === "on" || state === "absent" || state === "unsupported";
    $("push-test").hidden = state !== "on";
  }
  $("push-enable").onclick = async () => {
    const outcome = await enable();
    await settings().catch(() => {});
    $("push-status").textContent = PUSH_WORDS[outcome === "dismissed" ? "off" : outcome];
  };
  $("push-test").onclick = async () => {
    try {
      const body = await (await api("/api/push/test", { method: "POST" })).json();
      $("push-status").textContent = body.push === "absent" ? TEST_WORDS.absent : (TEST_WORDS[body.result] ?? TEST_WORDS.failed);
    } catch {
      $("push-status").textContent = TEST_WORDS.failed;
    }
  };

  return {
    needs(n) {
      waiting = Number(n) || 0;
      paintAsk().catch(() => {});
    },
    settings,
  };
}
