"""Real-Mongo end-to-end smoke for the §1 wallet-identity fix.

Mirrors logs/live-e2e-mongo.txt but deliberately gives each student a
clean_id that DIFFERS from its student_id, then asserts the attendance
reward credit lands under the UUID-style student_id (not clean_id) and is
visible through the existing GET /student/points/history endpoint.

Run: cd /app/backend && python3 scripts/e2e_attendance_wallet.py
"""
import asyncio
import os
import sys

from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

load_dotenv()
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import attendance_tools as att
import wallet_service as ws


class _Router:
    def __init__(self):
        self.routes = {}

    def _mk(self, m, p):
        def d(fn):
            self.routes[(m, p)] = fn
            return fn
        return d

    def get(self, p):
        return self._mk("GET", p)

    def post(self, p):
        return self._mk("POST", p)

    def put(self, p):
        return self._mk("PUT", p)

    def delete(self, p):
        return self._mk("DELETE", p)


class _Admin:
    email = "e2e-admin@example.com"
    is_admin = True


class _Student:
    def __init__(self, student_id, clean_id):
        self.student_id = student_id
        self.clean_id = clean_id


async def _call(router, m, p, **kw):
    return await router.routes[(m, p)](**kw)


async def main():
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]

    # distinct clean_id != student_id
    ALICE = _Student("stu_e2ealice0001", "e2e_alice")
    BOB = _Student("stu_e2ebob00002", "e2e_bob")

    # clean slate for our test ids
    for s in (ALICE, BOB):
        await db.students.delete_many({"clean_id": s.clean_id})
        await db.points_wallets.delete_many({"student_id": s.student_id})
        await db.points_transactions.delete_many({"$or": [{"to_id": s.student_id}, {"from_id": s.student_id}]})
        await db.points_transactions.delete_many({"$or": [{"to_id": s.clean_id}, {"from_id": s.clean_id}]})
        await db.points_wallets.delete_many({"student_id": s.clean_id})
        await db.attendance_streaks.delete_many({"student_id": s.clean_id})
    await db.attendance_classes.delete_many({"title_en": "E2E Identity Class"})

    for s in (ALICE, BOB):
        await db.students.insert_one({
            "student_id": s.student_id, "clean_id": s.clean_id,
            "display_name": s.clean_id.upper(), "is_active": True,
        })

    router = _Router()
    wallet = ws.WalletService(db)

    async def fan_out(query, title, body, url):
        return (0, 0)

    def build_q(target, ids, group):
        return {"target": target, "studentId": {"$in": list(ids or [])}}

    att.register_attendance_routes(
        router, db, require_admin=_Admin(), require_student=object(),
        current_student=None, fan_out_push=fan_out, build_target_query=build_q,
        norm_student_id=lambda v: str(v or "").strip().lower(), wallet=wallet,
    )
    ws.register_student_points_routes(router, db, require_student=object())

    # 1) class + session
    cls = await _call(router, "POST", "/admin/attendance/classes",
                      payload=att.ClassIn(title_en="E2E Identity Class",
                                          roster=[ALICE.clean_id, BOB.clean_id]),
                      admin=_Admin())
    cid = cls["class"]["class_id"]
    sess = await _call(router, "POST", "/admin/attendance/sessions",
                       payload=att.SessionIn(class_id=cid,
                                             meet_url="https://meet.google.com/real-e2e"),
                       admin=_Admin())
    sid = sess["session"]["session_id"]
    slug = sess["join_slug"]
    await _call(router, "POST", "/admin/attendance/sessions/{session_id}/open",
                session_id=sid, admin=_Admin())

    # 2) alice checks in (only alice)
    chk = await _call(router, "POST", "/attendance/checkin",
                      payload=att.CheckInIn(slug=slug), student=ALICE)
    assert chk["meet_url"] == "https://meet.google.com/real-e2e", "meet url must return"

    # 3) close session (credits alice, bob absent)
    res = await _call(router, "POST", "/admin/attendance/sessions/{session_id}/close",
                      session_id=sid, admin=_Admin())
    print("close:", res)
    assert res["rewards_credited"] == 1, res

    # 4) inspect points_transactions for source=attendance
    txns = await db.points_transactions.find(
        {"source": "attendance", "source_ref": sid}, {"_id": 0}).to_list(50)
    print("attendance txns:", [(t["to_id"], t["amount"], t.get("payload", {}).get("clean_id")) for t in txns])
    assert len(txns) == 1, "exactly one credit"
    t = txns[0]
    assert t["to_id"] == ALICE.student_id, f"BUG: credit filed under {t['to_id']}, expected {ALICE.student_id}"
    assert t["to_id"] != ALICE.clean_id, "credit must NOT be under clean_id"
    # clean_id is kept as metadata on the wallet doc (via the credit() clean_id kwarg).
    wdoc = await db.points_wallets.find_one({"student_id": ALICE.student_id}, {"_id": 0})
    print("alice wallet:", {"student_id": wdoc["student_id"], "clean_id": wdoc.get("clean_id"), "balance": wdoc.get("balance")})
    assert wdoc and wdoc.get("clean_id") == ALICE.clean_id, "clean_id kept as wallet metadata"

    # 5) idempotency: close again, still exactly one
    await _call(router, "POST", "/admin/attendance/sessions/{session_id}/close",
                session_id=sid, admin=_Admin())
    txns2 = await db.points_transactions.find(
        {"source": "attendance", "source_ref": sid}).to_list(50)
    assert len(txns2) == 1, "no double-pay after second close"

    # 6) GET /student/points/history (the endpoint the Reward Vault reads) —
    #    keyed by student_id; the attendance credit MUST appear for alice…
    hist_alice = await _call(router, "GET", "/student/points/history", student=ALICE)
    att_rows = [r for r in hist_alice["transactions"] if r.get("source") == "attendance"]
    print("alice history attendance rows:", att_rows)
    assert hist_alice["mode"] == "mongo", hist_alice
    assert att_rows, "attendance credit must surface in alice's points history (by student_id)"

    # …and querying history under the clean_id must find NOTHING (proves the
    #   old behaviour would have hidden the points).
    fake_clean_student = _Student(ALICE.clean_id, ALICE.clean_id)
    hist_clean = await _call(router, "GET", "/student/points/history", student=fake_clean_student)
    att_rows_clean = [r for r in hist_clean["transactions"] if r.get("source") == "attendance"]
    assert not att_rows_clean, "history under clean_id must be empty (it is not the wallet identity)"

    print("\nE2E PASS: attendance reward credited under student_id, visible in /student/points/history, idempotent.")
    client.close()


if __name__ == "__main__":
    asyncio.run(main())
