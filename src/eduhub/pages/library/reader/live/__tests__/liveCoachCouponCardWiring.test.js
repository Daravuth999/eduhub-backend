/**
 * liveCoachCouponCardWiring.test.js — proves the Live Voice Coach Coupon
 * card is wired into EduTalkLiveCoach.jsx additively: mounted only inside
 * the pre-session "start" phase block (never the "live" phase), gated by
 * config.couponRedemptionEnabled, passed via LiveCoachStartCard's
 * couponSlot prop (so it renders between the session summary/balance row
 * and the Start button, per the required order), and that the existing
 * session-start wiring (startSession, config.modes, LiveCoachStartCard
 * props) is untouched. Follows the same static-source-assertion pattern
 * already used by liveCoachRewardResilience.test.js for this same file
 * (full render is avoided here deliberately — this component has heavy
 * mic/AudioContext/WebSocket dependencies that are out of scope for this
 * change).
 */
import fs from "fs";
import path from "path";

const COMPONENT = fs.readFileSync(
  path.join(__dirname, "..", "EduTalkLiveCoach.jsx"), "utf8");

test("imports LiveCoachCouponCard", () => {
  expect(COMPONENT).toMatch(/import LiveCoachCouponCard from "\.\/LiveCoachCouponCard"/);
});

test("mounts the coupon card gated by config.couponRedemptionEnabled", () => {
  expect(COMPONENT).toMatch(/<LiveCoachCouponCard[\s\S]{0,200}enabled=\{!!\(config && config\.couponRedemptionEnabled\)\}/);
});

test("coupon card is passed into LiveCoachStartCard via the couponSlot prop (not a sibling)", () => {
  const startBlockMatch = COMPONENT.match(/phase === "start" && \(([\s\S]*?)\)\}\s*\n\s*\{phase === "live"/);
  expect(startBlockMatch).not.toBeNull();
  const startBlock = startBlockMatch[1];
  expect(startBlock).toMatch(/<LiveCoachStartCard/);
  expect(startBlock).toMatch(/couponSlot=\{[\s\S]*?<LiveCoachCouponCard/);
});

test("existing session-start wiring (startSession, config.modes) is unmodified by this change", () => {
  expect(COMPONENT).toMatch(/onStart=\{startSession\}/);
  expect(COMPONENT).toMatch(/modes=\{config\.modes \|\| \[\]\}/);
});

test("onRedeemed refreshes balance via the existing setBalance helper (absolute new value, not a raw increment call to a different API)", () => {
  const match = COMPONENT.match(/onRedeemed=\{([\s\S]*?)\}\}\s*\/>/);
  expect(match).not.toBeNull();
  expect(match[1]).toMatch(/setBalance\(\(balance \|\| 0\) \+ amount\)/);
});
