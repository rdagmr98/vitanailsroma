#!/usr/bin/env python3
"""Offline selfcheck for duration-based booking logic (mirror of js/booking.js)."""
import hashlib, json, os, re, sys, uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(os.environ.get("VITA_DATA_DIR", ROOT / "data"))
SLOT_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$")
TIME_RE = re.compile(r"^\d{2}:\d{2}$")


def sha256(s):
    return hashlib.sha256(str(s).encode("utf-8")).hexdigest()


def load(name):
    return json.loads((DATA / name).read_text(encoding="utf-8"))


def save(name, obj):
    (DATA / name).write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def now():
    return datetime.now(timezone.utc)


def parse_slot(s):
    return datetime.strptime(s, "%Y-%m-%dT%H:%M")


def slot_id(dt):
    return dt.strftime("%Y-%m-%dT%H:%M")


def fail(msg):
    print(json.dumps({"ok": False, "error": msg}))
    sys.exit(1)


def ok(**extra):
    print(json.dumps({"ok": True, **extra}))


def expire_pending(bookings, hours):
    cut = now() - timedelta(hours=hours)
    for b in bookings:
        if b["status"] == "pending":
            created = datetime.fromisoformat(b["createdAt"].replace("Z", "+00:00"))
            if created < cut:
                b["status"] = "expired"


def booking_end(b):
    start = parse_slot(b["slotId"])
    return start + timedelta(minutes=int(b.get("duration") or 60))


def overlaps(a0, a1, b0, b1):
    return a0 < b1 and b0 < a1


def conflicts(bookings, blocks, start_id, duration, except_code=None):
    start = parse_slot(start_id)
    end = start + timedelta(minutes=duration)
    for b in bookings:
        if b["status"] not in ("pending", "confirmed"):
            continue
        if except_code and b["code"] == except_code:
            continue
        bs, be = parse_slot(b["slotId"]), booking_end(b)
        if overlaps(start, end, bs, be):
            return True
    for bl in blocks.get("blocks") or []:
        if overlaps(start, end, parse_slot(bl["start"]), parse_slot(bl["end"])):
            return True
    return False


def write_public(bookings, blocks):
    busy = []
    for b in bookings:
        if b["status"] in ("pending", "confirmed"):
            busy.append({"start": b["slotId"], "end": slot_id(booking_end(b))})
    codes = {
        b["code"]: {"status": b["status"], "slotId": b["slotId"]}
        for b in bookings
        if b["status"] in ("pending", "confirmed", "declined", "expired")
    }
    save("availability.json", {
        "busy": busy,
        "blocks": [{"start": bl["start"], "end": bl["end"], "note": bl.get("note", "")} for bl in blocks.get("blocks") or []],
        "codes": codes,
    })


def require_admin(p):
    admin = load("admin.json")
    if (p.get("adminId") or "") != admin["id"]:
        fail("auth")
    # plain or sha256 MVP
    pw = p.get("password") or ""
    if "password" in admin and pw != admin["password"]:
        fail("auth")
    if "passwordSha256" in admin and sha256(pw) != admin["passwordSha256"]:
        fail("auth")


def new_code(bookings, raw=""):
    raw = (raw or "").strip().upper()
    code = raw if re.match(r"^VN-[A-F0-9]{6}$", raw) else "VN-" + uuid.uuid4().hex[:6].upper()
    if any(b["code"] == code for b in bookings):
        fail("code")
    return code


def svc_duration(svc_id):
    for s in load("services.json"):
        if s["id"] == svc_id:
            return max(5, int(s.get("duration") or 60))
    fail("service")


def op_book(p, confirmed=False):
    name = (p.get("name") or "").strip()
    slot = p.get("slotId") or ""
    svc = p.get("serviceId") or ""
    if not name or len(name) > 80 or not SLOT_RE.match(slot):
        fail("invalid")
    duration = svc_duration(svc)
    cfg = load("slots.json")
    blocks = load("blocks.json") if (DATA / "blocks.json").exists() else {"blocks": []}
    data = load("bookings.json")
    expire_pending(data["bookings"], cfg.get("pendingHours", 48))
    if not confirmed and sum(1 for b in data["bookings"] if b["status"] == "pending") >= 40:
        fail("busy")
    if conflicts(data["bookings"], blocks, slot, duration):
        fail("taken")
    code = new_code(data["bookings"], p.get("code"))
    data["bookings"].append({
        "id": code, "code": code, "slotId": slot, "serviceId": svc, "name": name,
        "duration": duration, "note": (p.get("note") or "")[:200],
        "status": "confirmed" if confirmed else "pending",
        "source": (p.get("source") or ("voce" if confirmed else "online"))[:40],
        "createdAt": now().isoformat().replace("+00:00", "Z"),
    })
    save("bookings.json", data)
    write_public(data["bookings"], blocks)
    ok(code=code, status="confirmed" if confirmed else "pending", slotId=slot)


def op_accept(p):
    require_admin(p)
    blocks = load("blocks.json") if (DATA / "blocks.json").exists() else {"blocks": []}
    data = load("bookings.json")
    b = next((x for x in data["bookings"] if x["code"] == p.get("code")), None)
    if not b or b["status"] != "pending":
        fail("notfound")
    if conflicts(data["bookings"], blocks, b["slotId"], int(b.get("duration") or 60), b["code"]):
        fail("taken")
    b["status"] = "confirmed"
    save("bookings.json", data)
    write_public(data["bookings"], blocks)
    ok(code=b["code"])


def op_change_password(p):
    require_admin(p)
    # ponytail: no length/complexity
    new = p.get("newPassword")
    if new is None:
        fail("weak")
    admin = load("admin.json")
    if "passwordSha256" in admin:
        save("admin.json", {"id": admin["id"], "passwordSha256": sha256(new)})
    else:
        save("admin.json", {"id": admin["id"], "password": str(new)})
    ok()


OPS = {
    "book": lambda p: op_book(p, False),
    "admin_book": lambda p: (require_admin(p), op_book(p, True)),
    "accept": op_accept,
    "change_password": op_change_password,
}


def selfcheck():
    import shutil, tempfile
    global DATA
    tmp = Path(tempfile.mkdtemp())
    shutil.copytree(ROOT / "data", tmp, dirs_exist_ok=True)
    DATA = tmp
    save("bookings.json", {"bookings": []})
    save("blocks.json", {"blocks": []})
    save("admin.json", {"id": "vita", "password": "x"})
    # duration 45 manicure — block should refuse overlap
    op_book({"name": "Anna", "slotId": "2099-01-06T10:00", "serviceId": "manicure"})
    data = load("bookings.json")
    assert data["bookings"][0]["duration"] == 45
    code = data["bookings"][0]["code"]
    pub = load("availability.json")
    assert pub["busy"][0]["start"] == "2099-01-06T10:00"
    assert pub["busy"][0]["end"] == "2099-01-06T10:45"
    try:
        op_book({"name": "B", "slotId": "2099-01-06T10:30", "serviceId": "manicure"})
        raise SystemExit("overlap failed")
    except SystemExit as e:
        if e.code != 1:
            raise
    save("blocks.json", {"blocks": [{"id": "B1", "start": "2099-01-07T10:00", "end": "2099-01-07T18:00", "note": "ferie"}]})
    try:
        op_book({"name": "C", "slotId": "2099-01-07T11:00", "serviceId": "manicure"})
        raise SystemExit("block failed")
    except SystemExit as e:
        if e.code != 1:
            raise
    op_accept({"adminId": "vita", "password": "x", "code": code})
    op_change_password({"adminId": "vita", "password": "x", "newPassword": "1"})
    assert load("admin.json")["password"] == "1"
    shutil.rmtree(tmp)
    print("selfcheck ok")


if __name__ == "__main__":
    if sys.argv[-1] == "selfcheck":
        selfcheck()
    else:
        fail("op")
