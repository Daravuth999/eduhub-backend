# Speaking Lab — One-Tap Join: Activation & Audit Runbook

**Status:** The full one-tap enrollment flow is built, tested, and
deployed (dark). It issues **no** tickets and charges **no** points
until Direct Join is switched on. Nothing in this file was executed by
Claude — turning the flag on is a financial action you perform.

---

## How the student flow works now

1. Teacher opens the teacher app → picks a schedule (A / B / Combined
   A+B) → taps **Start Session**. A session is created (status
   `waiting`).
2. Student opens **My Portal**. If a session they're eligible for is
   live, a **"Speaking Lab is Live — Join the Prize Pool"** card appears
   near the top automatically. No code typing.
3. Student taps **Join Now** — one request. The server resolves the
   student's active session, atomically charges the entry fee, creates
   the entry, and assigns the **Lucky Code (their ticket)**.
4. The card instantly shows **"You're In!"** with the Lucky Code. Done.
5. Later the teacher runs the **Lucky Draw**; winning codes are paid out.

**Reliability properties (already guaranteed):** exactly-once ticket, no
double charge (server-derived idempotency key), atomic all-or-nothing
transaction, the UI shows success only after the server confirms a
durable code, and every attempt is recorded in an audit trail. The card
**never shows a network error** on My Portal — it silently hides if
anything fails.

---

## Activation (required for any ticket to issue)

Direct Join is AND-gated: BOTH must be true, or it stays off.

**1. Render — set an environment variable** on the `eduhub-backend`
service → Environment:

```
SPEAKING_LAB_DIRECT_JOIN_ENABLED=true
```

Save (Render restarts the service automatically). Wait for the deploy to
finish.

**2. Production MongoDB — set the matching flag** (run once in
`mongosh` / Compass / Atlas):

```js
db.speaking_lab_settings.updateOne(
  { _id: "feature_flags" },
  { $set: { speaking_lab_direct_join_enabled: true } },
  { upsert: true }
)
```

That's it. The moment both are set and a teacher has a live session, the
one-tap card goes live for students.

**To turn it OFF again** (instant, safe, no data cleanup): set either
side back to false. Joins immediately return the friendly "not open yet"
state; nothing that already committed is affected.

> Combined A+B is already a standard schedule (no flag needed).
> The wallet-payout / cutover flags remain OFF and are unrelated to
> student enrollment — leave them off.

---

## Verify every participant got their ticket (audit trail)

Every enrollment attempt writes one row to
`speaking_lab_enrollment_audit`. Useful queries in `mongosh`:

**Everyone who successfully got a ticket in a session:**
```js
db.speaking_lab_enrollment_audit.find(
  { session_id: "sl_XXXXXXXXXXXXX", lucky_code_assigned: true }
).sort({ ts: 1 })
```

**Anyone who tried but did NOT get a ticket, with the reason:**
```js
db.speaking_lab_enrollment_audit.find(
  { session_id: "sl_XXXXXXXXXXXXX", lucky_code_assigned: false }
).sort({ ts: 1 })
// reason_code tells you why: insufficient_points, wrong_schedule,
// no_active_session, direct_join_disabled, etc.
```

**A single student's full attempt history:**
```js
db.speaking_lab_enrollment_audit.find({ student_id: "stu094" }).sort({ ts: 1 })
```

**Count of confirmed tickets vs the pool's entries (should match):**
```js
db.speaking_lab_enrollment_audit.countDocuments(
  { session_id: "sl_XXXXXXXXXXXXX", lucky_code_assigned: true, outcome: "committed" }
)
```

The audit trail stores `lucky_code_assigned` as a boolean — it never
stores the Lucky Code itself, so it is not an alternate source of a
student's ticket.

---

## Owner smoke test after activation (NOT executed by Claude — needs a real login)

- [ ] Teacher starts a session (ideally `entry_fee = 0` first, so the
      first live test costs nobody any points).
- [ ] On a student device, open My Portal → the "Speaking Lab is Live"
      card appears on its own (no code typed).
- [ ] Tap **Join Now** → the Lucky Code appears immediately.
- [ ] Reopen My Portal → the card shows "You're In!" with the same code
      (idempotent; not charged again).
- [ ] Check `speaking_lab_enrollment_audit` → one `committed` row with
      `lucky_code_assigned: true` for that student/session.
- [ ] With no live session, confirm the card is simply absent from My
      Portal (never an error).
