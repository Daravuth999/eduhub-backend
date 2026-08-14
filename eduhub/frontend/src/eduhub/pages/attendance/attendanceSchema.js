/**
 * attendanceSchema.js — frontend mirror of attendance_tools.py default_settings().
 * Pure constants: no backend coupling, no network calls.
 * Values must stay in sync with attendance_tools.default_settings().
 */

/** Ordered tier name list (lowest → highest). */
export const TIERS = ["bronze", "silver", "gold", "diamond"];

/** Frontend-safe default settings matching the backend default_settings() shape. */
export function defaultAttendanceSettings() {
  return {
    checkin_window_minutes: 90,
    late_grace_minutes: 10,
    mid_session_enabled: true,
    miss_threshold: 3,
    escalation_threshold: 70,
    base_attendance_points: 5,
    reward_tiers: [
      { tier: "bronze",  min_attendance_rate: 0.0,  min_on_time_rate: 0.0,  multiplier: 1.0  },
      { tier: "silver",  min_attendance_rate: 0.7,  min_on_time_rate: 0.6,  multiplier: 1.25 },
      { tier: "gold",    min_attendance_rate: 0.85, min_on_time_rate: 0.8,  multiplier: 1.5  },
      { tier: "diamond", min_attendance_rate: 0.95, min_on_time_rate: 0.9,  multiplier: 2.0  },
    ],
  };
}
