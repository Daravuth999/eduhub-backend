// criticalOperationRegistry.js — tracks business-critical async operations
// (points transfers, top-up/payment confirmation, Speaking Lab join) that
// must never be interrupted by a service-worker-driven update reload.
//
// Usage:
//   const end = beginCriticalOperation("send-points");
//   try {
//     await api.sendPoints(...);
//   } finally {
//     end();
//   }
//
// pwaUpdateController.js checks hasCriticalOperationInFlight() before
// reloading and defers (polls) until it's empty — an update is applied the
// instant the last critical operation ends, never mid-transaction.
const active = new Map();
let seq = 0;

export function beginCriticalOperation(label) {
  const id = `${label}:${++seq}`;
  active.set(id, { label, startedAt: Date.now() });
  let ended = false;
  return function endCriticalOperation() {
    if (ended) return; // idempotent — safe to call twice defensively
    ended = true;
    active.delete(id);
  };
}

export function hasCriticalOperationInFlight() {
  return active.size > 0;
}

export function listCriticalOperations() {
  return Array.from(active.values());
}
