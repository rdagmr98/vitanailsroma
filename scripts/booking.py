#!/usr/bin/env python3
import hashlib, json, os, re, sys, uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(os.environ.get("VITA_DATA_DIR", ROOT / "data"))
SLOT_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$")
TIME_RE = re.compile(r"^\d{2}:\d{2}$")


def sha256(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def load(name):
    return json.loads((DATA / name).read_text(encoding="utf-8"))


def save(name, obj):
    (DATA / name).write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def now():
    return datetime.now(timezone.utc)


def parse_iso(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def fail(msg):
    print(json.dumps({"ok": False, "error": msg}))
    sys.exit(1)


def ok(**extra):
    print(json.dumps({"ok": True, **extra}))


def expire_pending(bookings, hours):
    cut = now() - timedelta(hours=hours)
    for b in bookings:
        if b["status"] == "pending" and parse_iso(b["createdAt"]) < cut:
            b["status"] = "expired"


def occupied(bookings, slot_id):
    return any(b["slotId"] == slot_id and b["status"] in ("pending", "confirmed") for b in bookings)


def require_admin(p):
    admin = load("admin.json")
    if (p.get("adminId") or "") != admin["id"]:
        fail("auth")
    if sha256(p.get("password") or "") != admin["passwordSha256"]:
        fail("auth")


def op_book(p):
    name = (p.get("name") or "").strip()
    slot = p.get("slotId") or ""
    svc = p.get("serviceId") or ""
    if not name or len(name) > 80 or not SLOT_RE.match(slot):
        fail("invalid")
    services = {s["id"] for s in load("services.json")}
    if svc not in services:
        fail("service")
    cfg = load("slots.json")
    data = load("bookings.json")
    expire_pending(data["bookings"], cfg.get("pendingHours", 48))
    if sum(1 for b in data["bookings"] if b["status"] == "pending") >= 40:
        fail("busy")
    if occupied(data["bookings"], slot):
        fail("taken")
    raw = (p.get("code") or "").strip().upper()
    code = raw if re.match(r"^VN-[A-F0-9]{6}$", raw) else "VN-" + uuid.uuid4().hex[:6].upper()
    if any(b["code"] == code for b in data["bookings"]):
        fail("code")
    data["bookings"].append({
        "id": code,
        "code": code,
        "slotId": slot,
        "serviceId": svc,
        "name": name,
        "note": (p.get("note") or "")[:200],
        "status": "pending",
        "createdAt": now().isoformat(),
    })
    save("bookings.json", data)
    ok(code=code)


def op_accept(p):
    require_admin(p)
    cfg = load("slots.json")
    data = load("bookings.json")
    expire_pending(data["bookings"], cfg.get("pendingHours", 48))
    b = next((x for x in data["bookings"] if x["code"] == p.get("code")), None)
    if not b or b["status"] != "pending":
        fail("notfound")
    if any(x["slotId"] == b["slotId"] and x["status"] == "confirmed" for x in data["bookings"]):
        fail("taken")
    b["status"] = "confirmed"
    save("bookings.json", data)
    ok(code=b["code"])


def op_decline(p):
    require_admin(p)
    data = load("bookings.json")
    b = next((x for x in data["bookings"] if x["code"] == p.get("code")), None)
    if not b or b["status"] != "pending":
        fail("notfound")
    b["status"] = "declined"
    save("bookings.json", data)
    ok(code=b["code"])


def op_change_password(p):
    require_admin(p)
    new = p.get("newPassword") or ""
    if len(new) < 10:
        fail("weak")
    save("admin.json", {"id": load("admin.json")["id"], "passwordSha256": sha256(new)})
    ok()


def op_update_slots(p):
    require_admin(p)
    slots = p.get("slots") or {}
    days = slots.get("weekdays")
    times = slots.get("times")
    weeks = int(slots.get("weeksAhead", 4))
    hours = int(slots.get("pendingHours", 48))
    if not isinstance(days, list) or not days or any(d not in range(7) for d in days):
        fail("slots")
    if not isinstance(times, list) or not times or any(not TIME_RE.match(str(t)) for t in times):
        fail("slots")
    if weeks < 1 or weeks > 12 or hours < 1 or hours > 168:
        fail("slots")
    save("slots.json", {
        "weekdays": days,
        "times": times,
        "weeksAhead": weeks,
        "pendingHours": hours,
    })
    ok()


OPS = {
    "book": op_book,
    "accept": op_accept,
    "decline": op_decline,
    "change_password": op_change_password,
    "update_slots": op_update_slots,
}


def read_event():
    if os.environ.get("BOOKING_PAYLOAD"):
        return os.environ["BOOKING_OP"], json.loads(os.environ["BOOKING_PAYLOAD"])
    path = os.environ.get("GITHUB_EVENT_PATH")
    if not path:
        fail("event")
    ev = json.loads(Path(path).read_text(encoding="utf-8"))
    return ev.get("action"), ev.get("client_payload") or {}


def selfcheck():
    import shutil, tempfile
    global DATA
    tmp = Path(tempfile.mkdtemp())
    shutil.copytree(ROOT / "data", tmp, dirs_exist_ok=True)
    DATA = tmp
    save("bookings.json", {"bookings": []})
    save("admin.json", {"id": "vita", "passwordSha256": sha256("test-password-ok")})
    op_book({"name": "Anna", "slotId": "2099-01-06T10:00", "serviceId": "manicure"})
    data = load("bookings.json")
    assert data["bookings"][0]["status"] == "pending"
    code = data["bookings"][0]["code"]
    try:
        op_book({"name": "B", "slotId": "2099-01-06T10:00", "serviceId": "manicure"})
        raise SystemExit("lock failed")
    except SystemExit as e:
        if e.code != 1:
            raise
    os.environ.pop("BOOKING_PAYLOAD", None)
    op_accept({"adminId": "vita", "password": "test-password-ok", "code": code})
    assert load("bookings.json")["bookings"][0]["status"] == "confirmed"
    shutil.rmtree(tmp)
    print("selfcheck ok")


if __name__ == "__main__":
    if sys.argv[-1] == "selfcheck":
        selfcheck()
    else:
        op, payload = read_event()
        fn = OPS.get(op)
        if not fn:
            fail("op")
        fn(payload)
