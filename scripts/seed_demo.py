"""Seed a demo student with rich attendance history for live screenshots.

Creates: a student (login: clean_id=`dara`, password=`Passport123`), a class,
a run of finalized sessions + attendance_records (varied statuses), a streak
doc (gold tier), a live open session (for the live banner), and a few
attendance reward transactions so the Reward Vault renders.

Run: cd /app/backend && python3 scripts/seed_demo.py
"""
import asyncio
import os
import secrets
from datetime import datetime, timedelta, timezone

import bcrypt
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

load_dotenv()

CLEAN_ID = "dara"
STUDENT_ID = "stu_passportdemo01"
PASSWORD = "Passport123"


def iso(dt):
    return dt.astimezone(timezone.utc).isoformat()


async def main():
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]
    now = datetime.now(timezone.utc)

    # ---- student ----
    pw_hash = bcrypt.hashpw(PASSWORD.encode(), bcrypt.gensalt()).decode()
    await db.students.delete_many({"clean_id": CLEAN_ID})
    await db.students.insert_one({
        "student_id": STUDENT_ID, "clean_id": CLEAN_ID,
        "display_name": "Dara", "group": "A1", "is_active": True,
        "password_hash": pw_hash, "created_at": iso(now),
    })

    # ---- class ----
    cid = "cls_demo_passport"
    await db.attendance_classes.delete_many({"class_id": cid})
    await db.attendance_classes.insert_one({
        "class_id": cid, "title_en": "English A1 — Evening", "title_kh": "ភាសាអង់គ្លេស A1",
        "teacher": "Teacher Daravuth", "recurrence": "Mon/Wed/Fri", "group": "A1",
        "roster": [CLEAN_ID], "created_at": iso(now),
    })

    # ---- history: finalized sessions + records (checked-in only show in /me) ----
    statuses = [
        "present_full", "present_full", "late", "present_full", "present_partial",
        "present_full", "present_full", "late", "present_full", "present_full",
        "present_partial", "present_full",
    ]
    await db.attendance_sessions.delete_many({"class_id": cid})
    await db.attendance_records.delete_many({"student_id": CLEAN_ID})
    for i, st in enumerate(statuses):
        day = now - timedelta(days=(len(statuses) - i) * 2 + 1)
        sid = f"ses_demo_{i:02d}"
        await db.attendance_sessions.insert_one({
            "session_id": sid, "class_id": cid, "date": day.date().isoformat(),
            "join_slug": f"demo{i:02d}", "meet_url": "https://meet.google.com/demo",
            "opens_at": iso(day), "closes_at": iso(day + timedelta(hours=1)),
            "grace_minutes": 10, "mid_session_enabled": True,
            "status": "closed", "created_at": iso(day), "closed_at": iso(day + timedelta(hours=1)),
        })
        await db.attendance_records.insert_one({
            "_id": f"{sid}:{CLEAN_ID}", "student_id": CLEAN_ID, "session_id": sid,
            "class_id": cid, "status": st, "checkin_status": st,
            "checked_in_at": iso(day + timedelta(minutes=2)),
            "mid_session_confirmed": st != "present_partial",
            "method": "checkin", "attributed_via": "session_identity",
            "finalized": True, "updated_at": iso(day),
        })

    # ---- streak / tier ----
    await db.attendance_streaks.delete_many({"student_id": CLEAN_ID})
    await db.attendance_streaks.insert_one({
        "student_id": CLEAN_ID, "current_streak": 5, "longest_streak": 9,
        "reliability_tier": "gold", "on_time_rate_rolling": 0.83,
        "attendance_rate": 0.92, "risk_score": 18, "risk_band": "standard",
        "updated_at": iso(now),
    })

    # ---- reward transactions (Reward Vault reads /student/points/history) ----
    await db.points_wallets.delete_many({"student_id": STUDENT_ID})
    await db.points_transactions.delete_many({"to_id": STUDENT_ID, "source": "attendance"})
    bal = 0
    for i in [0, 2, 4, 6, 8, 10]:
        amt = [10, 10, 7, 10, 5, 10][[0, 2, 4, 6, 8, 10].index(i)]
        bal += amt
        day = now - timedelta(days=(len(statuses) - i) * 2)
        await db.points_transactions.insert_one({
            "student_id": STUDENT_ID, "operation": "credit", "amount": amt, "delta": amt,
            "balance_after": bal, "source": "attendance", "source_ref": f"ses_demo_{i:02d}",
            "idempotency_key": f"attendance:ses_demo_{i:02d}:{STUDENT_ID}",
            "from_id": None, "to_id": STUDENT_ID, "status": "applied",
            "payload": {"clean_id": CLEAN_ID}, "created_at": day,
        })
    await db.points_wallets.insert_one({
        "student_id": STUDENT_ID, "clean_id": CLEAN_ID, "balance": bal,
        "status": "active", "created_at": iso(now), "updated_at": iso(now),
    })

    # ---- a live OPEN session (drives the floating live banner) ----
    live_slug = "liveDemo"
    await db.attendance_sessions.delete_many({"session_id": "ses_demo_live"})
    await db.attendance_sessions.insert_one({
        "session_id": "ses_demo_live", "class_id": cid, "date": now.date().isoformat(),
        "join_slug": live_slug, "meet_url": "https://meet.google.com/live-demo",
        "opens_at": iso(now - timedelta(minutes=5)), "closes_at": iso(now + timedelta(hours=1)),
        "grace_minutes": 10, "mid_session_enabled": True,
        "status": "open", "opened_at": iso(now), "created_at": iso(now),
    })

    print(f"Seeded student clean_id={CLEAN_ID} password={PASSWORD} student_id={STUDENT_ID}")
    print(f"History entries: {len(statuses)} | reward total: {bal} | live slug: {live_slug}")
    client.close()


if __name__ == "__main__":
    asyncio.run(main())
