const SLOT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const CODE_RE = /^VN-[A-F0-9]{6}$/;

function bust(url) {
  return url + (url.indexOf("?") >= 0 ? "&" : "?") + "t=" + Date.now();
}

function apiReady() {
  return !!(window.VITA_GH && window.VITA_GH.token);
}

async function loadJson(name) {
  if (!apiReady()) throw new Error("noapi");
  const f = await VitaGhDb.getFile(name);
  if (!f.data) throw new Error(name);
  return f.data;
}

function expandSlots(cfg, occupied) {
  const taken = new Set(occupied || []);
  const out = [];
  const start = new Date();
  for (let d = 0; d < cfg.weeksAhead * 7; d++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + d);
    if (!cfg.weekdays.includes(day.getDay())) continue;
    for (const t of cfg.times) {
      const [h, m] = t.split(":").map(Number);
      const slot = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
      if (slot <= new Date()) continue;
      const id = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}T${t}`;
      out.push({ id, t: slot, taken: taken.has(id) });
    }
  }
  return out;
}

function publicAvailability(bookings) {
  const occupied = [];
  const codes = {};
  for (const b of bookings) {
    if (b.status === "pending" || b.status === "confirmed") {
      if (!occupied.includes(b.slotId)) occupied.push(b.slotId);
    }
    if (["pending", "confirmed", "declined", "expired"].includes(b.status)) {
      codes[b.code] = { status: b.status, slotId: b.slotId };
    }
  }
  occupied.sort();
  return { occupied, codes };
}

function expirePending(bookings, hours) {
  const cut = Date.now() - hours * 3600 * 1000;
  for (const b of bookings) {
    if (b.status === "pending" && new Date(b.createdAt).getTime() < cut) b.status = "expired";
  }
}

function occupied(bookings, slotId) {
  return bookings.some(b => b.slotId === slotId && (b.status === "pending" || b.status === "confirmed"));
}

function newCode(bookings, raw) {
  raw = String(raw || "").trim().toUpperCase();
  let code = CODE_RE.test(raw)
    ? raw
    : "VN-" + [...crypto.getRandomValues(new Uint8Array(3))].map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  if (bookings.some(b => b.code === code)) throw new Error("code");
  return code;
}

async function syncPublic(bookings) {
  const av = publicAvailability(bookings);
  await VitaGhDb.writeWithRetry("availability.json", () => av, "vita: availability");
  return av;
}

async function requireAdmin(p) {
  const admin = await loadJson("admin.json");
  if ((p.adminId || "") !== admin.id) throw new Error("auth");
  if ((p.password || "") !== admin.password) throw new Error("auth");
}

async function api(op, p) {
  if (!apiReady()) throw new Error("noapi");

  if (op === "book") {
    const name = String(p.name || "").trim();
    const slot = p.slotId || "";
    const svc = p.serviceId || "";
    if (!name || name.length > 80 || !SLOT_RE.test(slot)) throw new Error("invalid");
    const services = await loadJson("services.json");
    if (!services.some(s => s.id === svc)) throw new Error("service");
    const slots = await loadJson("slots.json");
    let codeOut = "";
    const data = await VitaGhDb.writeWithRetry("bookings.json", (cur) => {
      const root = cur && Array.isArray(cur.bookings) ? cur : { bookings: [] };
      expirePending(root.bookings, slots.pendingHours || 48);
      if (root.bookings.filter(b => b.status === "pending").length >= 40) throw new Error("busy");
      if (occupied(root.bookings, slot)) throw new Error("taken");
      const code = newCode(root.bookings, p.code);
      codeOut = code;
      root.bookings.push({
        id: code, code, slotId: slot, serviceId: svc, name,
        note: String(p.note || "").slice(0, 200),
        status: "pending", source: "online",
        createdAt: new Date().toISOString(),
      });
      return root;
    }, "vita: book");
    await syncPublic(data.bookings);
    return { ok: true, code: codeOut, status: "pending", slotId: slot };
  }

  if (op === "admin_book") {
    await requireAdmin(p);
    const name = String(p.name || "").trim();
    const slot = p.slotId || "";
    const svc = p.serviceId || "";
    if (!name || name.length > 80 || !SLOT_RE.test(slot)) throw new Error("invalid");
    const services = await loadJson("services.json");
    if (!services.some(s => s.id === svc)) throw new Error("service");
    const slots = await loadJson("slots.json");
    let codeOut = "";
    const data = await VitaGhDb.writeWithRetry("bookings.json", (cur) => {
      const root = cur && Array.isArray(cur.bookings) ? cur : { bookings: [] };
      expirePending(root.bookings, slots.pendingHours || 48);
      if (occupied(root.bookings, slot)) throw new Error("taken");
      const code = newCode(root.bookings, p.code);
      codeOut = code;
      root.bookings.push({
        id: code, code, slotId: slot, serviceId: svc, name,
        note: String(p.note || "").slice(0, 200),
        status: "confirmed",
        source: String(p.source || "voce").slice(0, 40),
        createdAt: new Date().toISOString(),
      });
      return root;
    }, "vita: admin_book");
    await syncPublic(data.bookings);
    return { ok: true, code: codeOut, status: "confirmed", slotId: slot };
  }

  if (op === "accept" || op === "decline" || op === "cancel") {
    await requireAdmin(p);
    const data = await VitaGhDb.writeWithRetry("bookings.json", (cur) => {
      const root = cur && Array.isArray(cur.bookings) ? cur : { bookings: [] };
      const b = root.bookings.find(x => x.code === p.code);
      if (!b) throw new Error("notfound");
      if (op === "accept") {
        if (b.status !== "pending") throw new Error("notfound");
        if (root.bookings.some(x => x.slotId === b.slotId && x.status === "confirmed" && x.code !== b.code)) {
          throw new Error("taken");
        }
        b.status = "confirmed";
      } else if (op === "decline") {
        if (b.status !== "pending") throw new Error("notfound");
        b.status = "declined";
      } else {
        if (b.status !== "pending" && b.status !== "confirmed") throw new Error("notfound");
        b.status = "cancelled";
      }
      return root;
    }, "vita: " + op);
    await syncPublic(data.bookings);
    return { ok: true, code: p.code };
  }

  if (op === "change_password") {
    await requireAdmin(p);
    const neu = p.newPassword || "";
    if (neu.length < 6) throw new Error("weak");
    await VitaGhDb.writeWithRetry("admin.json", (cur) => ({
      id: (cur && cur.id) || p.adminId,
      password: neu,
    }), "vita: password");
    return { ok: true };
  }

  if (op === "update_slots") {
    await requireAdmin(p);
    const slots = p.slots || {};
    const days = slots.weekdays;
    const times = slots.times;
    const weeks = parseInt(slots.weeksAhead, 10) || 4;
    const hours = parseInt(slots.pendingHours, 10) || 48;
    if (!Array.isArray(days) || !days.length || days.some(d => d < 0 || d > 6)) throw new Error("slots");
    if (!Array.isArray(times) || !times.length || times.some(t => !TIME_RE.test(String(t)))) throw new Error("slots");
    if (weeks < 1 || weeks > 12 || hours < 1 || hours > 168) throw new Error("slots");
    const next = { weekdays: days, times, weeksAhead: weeks, pendingHours: hours };
    await VitaGhDb.writeWithRetry("slots.json", () => next, "vita: slots");
    return { ok: true };
  }

  throw new Error("op");
}

window.VitaBook = { loadJson, api, expandSlots, apiReady, bust };
