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

function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function hhmm(d) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function parseSlotId(id) {
  const m = String(id || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

function minsOf(t) {
  const [h, m] = String(t).split(":").map(Number);
  return h * 60 + m;
}

function addMins(d, n) {
  return new Date(d.getTime() + n * 60000);
}

function slotIdOf(d) {
  return `${ymd(d)}T${hhmm(d)}`;
}

function overlaps(a0, a1, b0, b1) {
  return a0 < b1 && b0 < a1;
}

function bookingRange(b) {
  const start = parseSlotId(b.slotId);
  if (!start) return null;
  const dur = Math.max(5, parseInt(b.duration, 10) || 60);
  return { start, end: addMins(start, dur) };
}

function busyIntervals(bookings, blocks) {
  const out = [];
  for (const b of bookings || []) {
    if (b.status !== "pending" && b.status !== "confirmed") continue;
    const r = bookingRange(b);
    if (r) out.push({ start: slotIdOf(r.start), end: slotIdOf(r.end) });
  }
  for (const bl of (blocks && blocks.blocks) || blocks || []) {
    if (bl.start && bl.end) out.push({ start: bl.start, end: bl.end });
  }
  return out;
}

function intervalTaken(start, end, intervals) {
  const a0 = start.getTime();
  const a1 = end.getTime();
  for (const iv of intervals || []) {
    const b0 = parseSlotId(iv.start);
    const b1 = parseSlotId(iv.end);
    if (b0 && b1 && overlaps(a0, a1, b0.getTime(), b1.getTime())) return true;
  }
  return false;
}

/** Free starts from working hours + service duration + busy/blocks. */
function expandSlots(hours, durationMin, intervals) {
  const dur = Math.max(5, parseInt(durationMin, 10) || 60);
  const step = Math.max(5, parseInt(hours.stepMinutes, 10) || 30);
  const openM = minsOf(hours.open || "10:00");
  const closeM = minsOf(hours.close || "18:00");
  const weeks = Math.max(1, parseInt(hours.weeksAhead, 10) || 4);
  const days = hours.weekdays || [2, 3, 4, 5, 6];
  const out = [];
  const now = new Date();
  const startDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let d = 0; d < weeks * 7; d++) {
    const day = new Date(startDay.getFullYear(), startDay.getMonth(), startDay.getDate() + d);
    if (!days.includes(day.getDay())) continue;
    for (let m = openM; m + dur <= closeM; m += step) {
      const slot = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(m / 60), m % 60);
      if (slot <= now) continue;
      const end = addMins(slot, dur);
      const id = slotIdOf(slot);
      out.push({ id, t: slot, end, taken: intervalTaken(slot, end, intervals) });
    }
  }
  return out;
}

function publicAvailability(bookings, blocksRoot) {
  const busy = [];
  const codes = {};
  for (const b of bookings) {
    if (b.status === "pending" || b.status === "confirmed") {
      const r = bookingRange(b);
      if (r) busy.push({ start: slotIdOf(r.start), end: slotIdOf(r.end) });
    }
    if (["pending", "confirmed", "declined", "expired"].includes(b.status)) {
      codes[b.code] = { status: b.status, slotId: b.slotId };
    }
  }
  const blocks = ((blocksRoot && blocksRoot.blocks) || []).map(bl => ({
    start: bl.start, end: bl.end, note: bl.note || "",
  }));
  return { busy, blocks, codes };
}

function expirePending(bookings, hours) {
  const cut = Date.now() - hours * 3600 * 1000;
  for (const b of bookings) {
    if (b.status === "pending" && new Date(b.createdAt).getTime() < cut) b.status = "expired";
  }
}

function conflicts(bookings, blocksRoot, startId, duration, exceptCode) {
  const start = parseSlotId(startId);
  if (!start) return true;
  const end = addMins(start, duration);
  const intervals = busyIntervals(
    (bookings || []).filter(b => b.code !== exceptCode),
    blocksRoot
  );
  return intervalTaken(start, end, intervals);
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
  let blocksRoot = { blocks: [] };
  try { blocksRoot = await loadJson("blocks.json"); } catch (_) { /* ok */ }
  const av = publicAvailability(bookings, blocksRoot);
  await VitaGhDb.writeWithRetry("availability.json", () => av, "vita: availability");
  return av;
}

async function requireAdmin(p) {
  const admin = await loadJson("admin.json");
  if ((p.adminId || "") !== admin.id) throw new Error("auth");
  if ((p.password || "") !== admin.password) throw new Error("auth");
}

function serviceDuration(services, id) {
  const s = (services || []).find(x => x.id === id);
  return Math.max(5, parseInt(s && s.duration, 10) || 60);
}

async function api(op, p) {
  if (!apiReady()) throw new Error("noapi");

  if (op === "book" || op === "admin_book") {
    if (op === "admin_book") await requireAdmin(p);
    const name = String(p.name || "").trim();
    const slot = p.slotId || "";
    const svc = p.serviceId || "";
    if (!name || name.length > 80 || !SLOT_RE.test(slot)) throw new Error("invalid");
    const services = await loadJson("services.json");
    if (!services.some(s => s.id === svc)) throw new Error("service");
    const hours = await loadJson("slots.json");
    const blocksRoot = await loadJson("blocks.json").catch(() => ({ blocks: [] }));
    const duration = serviceDuration(services, svc);
    let codeOut = "";
    const data = await VitaGhDb.writeWithRetry("bookings.json", (cur) => {
      const root = cur && Array.isArray(cur.bookings) ? cur : { bookings: [] };
      expirePending(root.bookings, hours.pendingHours || 48);
      if (op === "book" && root.bookings.filter(b => b.status === "pending").length >= 40) throw new Error("busy");
      if (conflicts(root.bookings, blocksRoot, slot, duration)) throw new Error("taken");
      const code = newCode(root.bookings, p.code);
      codeOut = code;
      root.bookings.push({
        id: code, code, slotId: slot, serviceId: svc, name,
        duration,
        note: String(p.note || "").slice(0, 200),
        status: op === "admin_book" ? "confirmed" : "pending",
        source: op === "admin_book" ? String(p.source || "voce").slice(0, 40) : "online",
        createdAt: new Date().toISOString(),
      });
      return root;
    }, "vita: " + op);
    await syncPublic(data.bookings);
    return { ok: true, code: codeOut, status: op === "admin_book" ? "confirmed" : "pending", slotId: slot };
  }

  if (op === "accept" || op === "decline" || op === "cancel") {
    await requireAdmin(p);
    const blocksRoot = await loadJson("blocks.json").catch(() => ({ blocks: [] }));
    const data = await VitaGhDb.writeWithRetry("bookings.json", (cur) => {
      const root = cur && Array.isArray(cur.bookings) ? cur : { bookings: [] };
      const b = root.bookings.find(x => x.code === p.code);
      if (!b) throw new Error("notfound");
      if (op === "accept") {
        if (b.status !== "pending") throw new Error("notfound");
        const dur = Math.max(5, parseInt(b.duration, 10) || 60);
        if (conflicts(root.bookings, blocksRoot, b.slotId, dur, b.code)) throw new Error("taken");
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
    // ponytail: no length/complexity — Vita picks any password
    const neu = String(p.newPassword ?? "");
    await VitaGhDb.writeWithRetry("admin.json", (cur) => ({
      id: (cur && cur.id) || p.adminId,
      password: neu,
    }), "vita: password");
    return { ok: true };
  }

  if (op === "update_hours") {
    await requireAdmin(p);
    const h = p.hours || {};
    const days = h.weekdays;
    const open = h.open || "10:00";
    const close = h.close || "18:00";
    const weeks = parseInt(h.weeksAhead, 10) || 4;
    const pend = parseInt(h.pendingHours, 10) || 48;
    const step = parseInt(h.stepMinutes, 10) || 30;
    if (!Array.isArray(days) || !days.length || days.some(d => d < 0 || d > 6)) throw new Error("hours");
    if (!TIME_RE.test(open) || !TIME_RE.test(close) || minsOf(open) >= minsOf(close)) throw new Error("hours");
    if (weeks < 1 || weeks > 12 || pend < 1 || pend > 168 || step < 5 || step > 120) throw new Error("hours");
    await VitaGhDb.writeWithRetry("slots.json", () => ({
      weekdays: days, open, close, weeksAhead: weeks, pendingHours: pend, stepMinutes: step,
    }), "vita: hours");
    return { ok: true };
  }

  if (op === "update_services") {
    await requireAdmin(p);
    const list = p.services;
    if (!Array.isArray(list) || !list.length) throw new Error("services");
    for (const s of list) {
      if (!s || !s.id || !s.it) throw new Error("services");
      const d = parseInt(s.duration, 10);
      if (!d || d < 5 || d > 480) throw new Error("services");
    }
    const next = list.map(s => ({
      id: String(s.id).slice(0, 40),
      price: String(s.price || "").slice(0, 20),
      duration: parseInt(s.duration, 10),
      it: String(s.it).slice(0, 120),
      ru: String(s.ru || s.it).slice(0, 120),
    }));
    await VitaGhDb.writeWithRetry("services.json", () => next, "vita: services");
    return { ok: true };
  }

  if (op === "update_blocks") {
    await requireAdmin(p);
    const list = Array.isArray(p.blocks) ? p.blocks : [];
    const next = [];
    for (const bl of list) {
      if (!SLOT_RE.test(bl.start) || !SLOT_RE.test(bl.end)) throw new Error("blocks");
      const a = parseSlotId(bl.start);
      const b = parseSlotId(bl.end);
      if (!a || !b || b <= a) throw new Error("blocks");
      next.push({
        id: String(bl.id || ("B-" + Date.now().toString(36))).slice(0, 24),
        start: bl.start,
        end: bl.end,
        note: String(bl.note || "").slice(0, 80),
      });
    }
    await VitaGhDb.writeWithRetry("blocks.json", () => ({ blocks: next }), "vita: blocks");
    const bookings = await loadJson("bookings.json");
    await syncPublic((bookings && bookings.bookings) || []);
    return { ok: true };
  }

  throw new Error("op");
}

window.VitaBook = {
  loadJson, api, expandSlots, apiReady, bust,
  mondayOf, ymd, hhmm, parseSlotId, busyIntervals, serviceDuration, addMins, slotIdOf,
};
