const DATA = "https://raw.githubusercontent.com/rdagmr98/vitanailsroma/main/data";

function bust(url) {
  return url + "?t=" + Date.now();
}

async function loadJson(name) {
  const r = await fetch(bust(`${DATA}/${name}`));
  if (!r.ok) throw new Error(name);
  return r.json();
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function dispatch(type, payload) {
  const token = window.VITA_DISPATCH_TOKEN;
  if (!token) throw new Error("notoken");
  const r = await fetch("https://api.github.com/repos/rdagmr98/vitanailsroma/dispatches", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + token,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ event_type: type, client_payload: payload }),
  });
  if (!r.ok) throw new Error("dispatch");
}

function expandSlots(cfg, bookings) {
  const taken = new Set(
    bookings.filter(b => b.status === "pending" || b.status === "confirmed").map(b => b.slotId)
  );
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

async function pollCode(code, tries = 20) {
  for (let i = 0; i < tries; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const data = await loadJson("bookings.json");
    const b = data.bookings.find(x => x.code === code);
    if (b) return b;
  }
  return null;
}

window.VitaBook = { loadJson, sha256hex, dispatch, expandSlots, pollCode };
