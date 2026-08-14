"""tests/test_assessment_award_real_wallet.py — LOCAL integration proof
that the Assessment Lab award path moves EXACT fractional points through
the REAL WalletService (not the in-memory fake) against a real MongoDB.

Skipped automatically when no local MongoDB is reachable (CI without a
DB). This is the test that would have caught the int(13.5) == 13 silent
truncation in wallet_service._coerce_amount.
"""
from __future__ import annotations

import asyncio
import os
import uuid

import pytest

motor = pytest.importorskip("motor.motor_asyncio")

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")


def _mongo_available() -> bool:
    async def ping():
        cli = motor.AsyncIOMotorClient(MONGO_URL, serverSelectionTimeoutMS=1500)
        try:
            await cli.admin.command("ping")
            return True
        except Exception:  # noqa: BLE001
            return False
        finally:
            cli.close()
    try:
        return asyncio.run(ping())
    except Exception:  # noqa: BLE001
        return False


pytestmark = pytest.mark.skipif(not _mongo_available(), reason="no local MongoDB reachable")


def test_real_wallet_credits_exact_13_point_5_and_is_idempotent():
    from wallet_service import WalletService

    async def scenario():
        cli = motor.AsyncIOMotorClient(MONGO_URL)
        db = cli[f"asmt_repair_it_{uuid.uuid4().hex[:8]}"]
        try:
            from wallet_service import ensure_wallet_indexes
            wallet = WalletService(db)
            await ensure_wallet_indexes(db)
            sid = "stu_integration_021"
            idem = "assessment_award:asub_integration_1"

            first = await wallet.credit(
                sid, 13.5, source="assessment_award",
                source_ref="asub_integration_1", idempotency_key=idem,
            )
            assert first["ok"] is True
            assert float(first["balance_after"]) == 13.5

            # Duplicate award attempt — must credit ZERO additional points.
            second = await wallet.credit(
                sid, 13.5, source="assessment_award",
                source_ref="asub_integration_1", idempotency_key=idem,
            )
            assert second.get("duplicate") is True
            assert float(second["balance_after"]) == 13.5

            doc = await db["points_wallets"].find_one({"student_id": sid})
            assert float(doc["balance"]) == 13.5

            # Whole-point credits remain exact ints alongside.
            third = await wallet.credit(
                sid, 15, source="assessment_award",
                source_ref="asub_integration_2",
                idempotency_key="assessment_award:asub_integration_2",
            )
            assert float(third["balance_after"]) == 28.5
        finally:
            await cli.drop_database(db.name)
            cli.close()

    asyncio.run(scenario())
