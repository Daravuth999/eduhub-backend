"""eduhub_platform/ — EduHub platform primitives (Architecture Reconstruction Phase 1).

Home for cross-cutting infrastructure with no business rules of its own —
identity resolution today; ledger/config/events/realtime/notify land here in
later phases per the accepted migration blueprint. Nothing in
`eduhub_platform/` may import from a business-domain module (attendance_tools,
mystery_box_tools, wallet_service, etc.) — dependencies flow one way, domain
-> platform.

Naming note: architecture.md's §4.0 tree names this package `platform/`.
Renamed to `eduhub_platform` because a top-level package literally named
`platform` shadows Python's own stdlib `platform` module for every import
in the process once the repo root is on sys.path (pytest adds it by
default; pymongo's internals call platform.python_implementation() at
import time) — confirmed by 13 test files failing to collect during Phase
1c. This is a naming-only deviation; the package's role and contents are
unchanged from the accepted architecture.
"""
