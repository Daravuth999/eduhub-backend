/**
 * templates.js — Campaign Design Studio 2.0 starter templates.
 * Selecting a template instantly generates a complete premium composition
 * (background surface + hero artwork + typography + marketing components +
 * effects), which the author then edits freely on the canvas.
 */
import {
  makeBackgroundLayer, makeImageLayer, makeTextLayer, makeComponentLayer,
  makeEffectLayer, normalizeCanvas,
} from "../../eduhub/lib/campaignCanvas/canvasSchema";
import { findAsset } from "./assetManifest";

function inDays(days) {
  return new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
}

function hero(assetId, frame, extra = {}) {
  const a = findAsset(assetId);
  return makeImageLayer({
    name: a?.label || assetId,
    src: a?.src || "",
    role: extra.role || "hero",
    frame,
    effects: {
      shadow: { enabled: true, preset: "soft", x: 0, y: 12, blur: 30, color: "#000000", opacity: 32 },
      glow: { enabled: Boolean(extra.glow), color: extra.glowColor || "#D9B872", blur: 30, opacity: 55 },
      blur: 0, radius: 0,
    },
    ...extra.layer,
  });

}

export const CAMPAIGN_TEMPLATES = [
  {
    id: "topUpBonus",
    label: "Top Up Bonus",
    hint: "Coins, countdown and a golden CTA",
    build: () => normalizeCanvas({
      schemaVersion: 2, aspect: "21/9", artworkMode: "composition",
      motion: { preset: "layeredElegant", enabled: true, idle: true },
      layers: [
        makeBackgroundLayer({ fill: { kind: "surface", surfaceId: "emeraldNight" }, overlay: { enabled: true, color: "#04120B", opacity: 18, gradientCss: "" } }),
        makeEffectLayer("premiumDust", { intensity: "medium" }),
        makeEffectLayer("spotlight", {}),
        hero("coin-rain", { x: 84, y: 38, w: 22, h: 62 }, { glow: true }),
        hero("coin-stack", { x: 72, y: 68, w: 22, h: 50 }, { glow: true }),
        makeTextLayer({ name: "Eyebrow", text: "THIS WEEK ONLY", styleId: "minimal", size: 2.2, frame: { x: 24, y: 22, w: 38 } }),
        makeTextLayer({ name: "Headline", text: "Top Up Bonus +20%", styleId: "premiumLuxury", size: 6.0, frame: { x: 31, y: 37, w: 52 } }),
        makeTextLayer({ name: "Subhead", text: "Extra points on every top up — fuel your reading streak.", styleId: "appleInspired", size: 2.6, frame: { x: 28, y: 55, w: 46 } }),
        makeComponentLayer("countdown", { name: "Countdown", props: { endsAt: inDays(7), showDays: true }, size: 2.3, frame: { x: 22, y: 76, w: 36 } }),
        makeComponentLayer("ctaButton", { name: "CTA", props: { label: "Top Up Now", style: "gold", action: { type: "topup", value: "" } }, size: 3.2, frame: { x: 56, y: 76, w: 20 } }),
      ],
    }),
  },
  {
    id: "scholarship",
    label: "Scholarship",
    hint: "Academic elegance with diploma",
    build: () => normalizeCanvas({
      schemaVersion: 2, aspect: "21/9", artworkMode: "composition",
      motion: { preset: "risingLuxury", enabled: true, idle: true },
      layers: [
        makeBackgroundLayer({ fill: { kind: "surface", surfaceId: "emeraldAuto" } }),
        makeEffectLayer("academicParticles", { intensity: "low" }),
        hero("diploma", { x: 78, y: 52, w: 26, h: 60 }),
        makeTextLayer({ name: "Eyebrow", text: "APPLICATIONS OPEN", styleId: "financial", size: 2.0, frame: { x: 24, y: 20, w: 38 } }),
        makeTextLayer({ name: "Headline", text: "Scholarship 2026", styleId: "emeraldStatement", size: 5.8, frame: { x: 29, y: 36, w: 50 } }),
        makeTextLayer({ name: "Subhead", text: "Full-year tuition support for our top readers.", styleId: "editorial", size: 2.6, frame: { x: 27, y: 55, w: 44 } }),
        makeComponentLayer("socialProof", { name: "Proof", props: { count: "320+", label: "scholars supported" }, size: 3.2, frame: { x: 25, y: 74, w: 26 } }),
        makeComponentLayer("ctaButton", { name: "CTA", props: { label: "Apply Today", style: "emerald", action: { type: "internal_route", value: "/portal" } }, size: 3.3, frame: { x: 52, y: 74, w: 20 } }),
      ],
    }),
  },
  {
    id: "vipMembership",
    label: "VIP Membership",
    hint: "Midnight royal with VIP seal",
    build: () => normalizeCanvas({
      schemaVersion: 2, aspect: "21/9", artworkMode: "composition",
      motion: { preset: "cinematic", enabled: true, idle: true },
      layers: [
        makeBackgroundLayer({ fill: { kind: "surface", surfaceId: "midnightRoyal" }, overlay: { enabled: true, color: "#050A14", opacity: 20, gradientCss: "" } }),
        makeEffectLayer("luxurySmoke", {}),
        makeEffectLayer("sparkles", { intensity: "low" }),
        makeComponentLayer("vipBadge", { name: "VIP Badge", props: { text: "VIP" }, size: 4.6, frame: { x: 79, y: 46, w: 22 } }),
        makeTextLayer({ name: "Eyebrow", text: "MEMBERS · INNER CIRCLE", styleId: "minimal", size: 2.0, frame: { x: 25, y: 22, w: 40 } }),
        makeTextLayer({ name: "Headline", text: "VIP Membership", styleId: "crystal", size: 6.0, frame: { x: 30, y: 37, w: 50 } }),
        makeTextLayer({ name: "Subhead", text: "Priority coaching, exclusive shelves, double rewards.", styleId: "appleInspired", size: 2.5, frame: { x: 28, y: 54, w: 46 } }),
        makeComponentLayer("priceCard", { name: "Price", props: { price: "2,900", unit: "PTS", strike: "4,000", caption: "per term" }, size: 2.5, frame: { x: 24, y: 78, w: 24 } }),
        makeComponentLayer("ctaButton", { name: "CTA", props: { label: "Become VIP", style: "gold", action: { type: "internal_route", value: "/portal" } }, size: 3.2, frame: { x: 54, y: 78, w: 20 } }),
      ],
    }),
  },
  {
    id: "luckySpin",
    label: "Lucky Spin",
    hint: "Festive ruby with gift energy",
    build: () => normalizeCanvas({
      schemaVersion: 2, aspect: "21/9", artworkMode: "composition",
      motion: { preset: "layeredElegant", enabled: true, idle: true },
      layers: [
        makeBackgroundLayer({ fill: { kind: "surface", surfaceId: "rubyFestival" } }),
        makeEffectLayer("confetti", { intensity: "medium" }),
        hero("gift-box", { x: 80, y: 56, w: 22, h: 56 }, { glow: true, glowColor: "#FFD9A0" }),
        makeComponentLayer("limitedRibbon", { name: "Ribbon", props: { text: "WEEKEND EVENT" }, size: 3.2, frame: { x: 27, y: 20, w: 30 } }),
        makeTextLayer({ name: "Headline", text: "Lucky Spin Festival", styleId: "magazine", size: 5.4, frame: { x: 30, y: 37, w: 52 } }),
        makeTextLayer({ name: "Subhead", text: "Spin every day — win points, boosts and mystery gifts.", styleId: "elegantSerif", size: 2.4, frame: { x: 29, y: 55, w: 48 } }),
        makeComponentLayer("highlightNumber", { name: "Highlight", props: { value: "x3", label: "win chances" }, size: 3.0, frame: { x: 26, y: 78, w: 18 } }),
        makeComponentLayer("ctaButton", { name: "CTA", props: { label: "Spin Now", style: "ruby", action: { type: "reward", value: "" } }, size: 3.4, frame: { x: 50, y: 78, w: 18 } }),
      ],
    }),
  },
  {
    id: "aiCoach",
    label: "AI Coach",
    hint: "Crystal tech with AI assistant",
    build: () => normalizeCanvas({
      schemaVersion: 2, aspect: "21/9", artworkMode: "composition",
      motion: { preset: "cinematic", enabled: true, idle: true },
      layers: [
        makeBackgroundLayer({ fill: { kind: "surface", surfaceId: "midnightRoyal" } }),
        makeEffectLayer("spotlight", { colorOverride: "rgba(120,180,255,0.22)" }),
        makeEffectLayer("sparkles", { intensity: "low", colorOverride: "#9CC4FF" }),
        hero("ai-assistant", { x: 79, y: 52, w: 22, h: 68 }, { glow: true, glowColor: "#7FB2FF" }),
        makeTextLayer({ name: "Eyebrow", text: "MEET YOUR STUDY PARTNER", styleId: "minimal", size: 2.0, frame: { x: 26, y: 22, w: 42 } }),
        makeTextLayer({ name: "Headline", text: "AI Coach, Always On", styleId: "crystal", size: 5.6, frame: { x: 30, y: 37, w: 52 } }),
        makeTextLayer({ name: "Subhead", text: "Practice speaking, fix weaknesses, level up daily.", styleId: "appleInspired", size: 2.5, frame: { x: 28, y: 54, w: 46 } }),
        makeComponentLayer("glassLabel", { name: "Label", props: { text: "Free for all students" }, size: 3.0, frame: { x: 27, y: 74, w: 24 } }),
        makeComponentLayer("ctaButton", { name: "CTA", props: { label: "Start Coaching", style: "glass", action: { type: "speaking_lab", value: "" } }, size: 3.3, frame: { x: 54, y: 74, w: 20 } }),
      ],
    }),
  },
  {
    id: "libraryPromotion",
    label: "Library Promotion",
    hint: "Warm emerald day with books",
    build: () => normalizeCanvas({
      schemaVersion: 2, aspect: "21/9", artworkMode: "composition",
      motion: { preset: "risingLuxury", enabled: true, idle: true },
      layers: [
        makeBackgroundLayer({ fill: { kind: "surface", surfaceId: "emeraldAuto" } }),
        makeEffectLayer("academicParticles", { intensity: "low" }),
        hero("books", { x: 78, y: 56, w: 24, h: 58 }),
        makeTextLayer({ name: "Eyebrow", text: "NEW SHELF · 40 TITLES", styleId: "financial", size: 2.0, frame: { x: 25, y: 21, w: 38 } }),
        makeTextLayer({ name: "Headline", text: "The Reading Season", styleId: "editorial", size: 5.4, frame: { x: 29, y: 36, w: 48 } }),
        makeTextLayer({ name: "Subhead", text: "Fresh stories, graded readers and audio adventures.", styleId: "academic", size: 2.5, frame: { x: 28, y: 55, w: 45 } }),
        makeComponentLayer("offerBadge", { name: "Badge", props: { text: "2X POINTS" }, size: 3.0, frame: { x: 26, y: 73, w: 24 } }),
        makeComponentLayer("ctaButton", { name: "CTA", props: { label: "Browse Library", style: "emerald", action: { type: "collection", value: "" } }, size: 3.3, frame: { x: 54, y: 74, w: 20 } }),
      ],
    }),
  },
  {
    id: "holidayEvent",
    label: "Holiday Event",
    hint: "Celebration gold, sparkles on",
    build: () => normalizeCanvas({
      schemaVersion: 2, aspect: "21/9", artworkMode: "composition",
      motion: { preset: "layeredElegant", enabled: true, idle: true },
      layers: [
        makeBackgroundLayer({ fill: { kind: "surface", surfaceId: "celebrationGold" } }),
        makeEffectLayer("sparkles", { intensity: "medium" }),
        makeEffectLayer("premiumDust", { intensity: "low" }),
        hero("celebration-burst", { x: 80, y: 44, w: 24, h: 60 }, { glow: true }),
        makeTextLayer({ name: "Eyebrow", text: "SCHOOL HOLIDAY SPECIAL", styleId: "minimal", size: 2.0, frame: { x: 26, y: 22, w: 40 } }),
        makeTextLayer({ name: "Headline", text: "Holiday Festival", styleId: "premiumLuxury", size: 6.2, frame: { x: 29, y: 38, w: 48 } }),
        makeTextLayer({ name: "Subhead", text: "Games, gifts and golden quests all week long.", styleId: "elegantSerif", size: 2.5, frame: { x: 28, y: 55, w: 45 } }),
        makeComponentLayer("countdown", { name: "Countdown", props: { endsAt: inDays(10), showDays: true }, size: 2.3, frame: { x: 22, y: 77, w: 36 } }),
        makeComponentLayer("ctaButton", { name: "CTA", props: { label: "Join the Event", style: "gold", action: { type: "reward", value: "" } }, size: 3.2, frame: { x: 56, y: 77, w: 20 } }),
      ],
    }),
  },
  {
    id: "speakingLab",
    label: "Speaking Lab",
    hint: "Confident emerald night",
    build: () => normalizeCanvas({
      schemaVersion: 2, aspect: "21/9", artworkMode: "composition",
      motion: { preset: "cinematic", enabled: true, idle: true },
      layers: [
        makeBackgroundLayer({ fill: { kind: "surface", surfaceId: "emeraldNight" } }),
        makeEffectLayer("lightRays", { intensity: "low" }),
        hero("phone", { x: 80, y: 54, w: 16, h: 66 }, { glow: true, glowColor: "#8FD6B2" }),
        makeTextLayer({ name: "Eyebrow", text: "LIVE · EVERY EVENING", styleId: "financial", size: 2.0, frame: { x: 25, y: 21, w: 38 } }),
        makeTextLayer({ name: "Headline", text: "Speaking Lab", styleId: "emeraldStatement", size: 6.4, frame: { x: 28, y: 37, w: 46 } }),
        makeTextLayer({ name: "Subhead", text: "Real conversations, native coaches, instant feedback.", styleId: "appleInspired", size: 2.5, frame: { x: 28, y: 54, w: 46 } }),
        makeComponentLayer("socialProof", { name: "Proof", props: { count: "1,800+", label: "sessions completed" }, size: 3.1, frame: { x: 26, y: 75, w: 26 } }),
        makeComponentLayer("ctaButton", { name: "CTA", props: { label: "Book a Session", style: "gold", action: { type: "speaking_lab", value: "" } }, size: 3.3, frame: { x: 54, y: 75, w: 20 } }),
      ],
    }),
  },
  {
    id: "courseLaunch",
    label: "Course Launch",
    hint: "Champagne editorial launch",
    build: () => normalizeCanvas({
      schemaVersion: 2, aspect: "21/9", artworkMode: "composition",
      motion: { preset: "risingLuxury", enabled: true, idle: true },
      layers: [
        makeBackgroundLayer({ fill: { kind: "surface", surfaceId: "champagne" } }),
        makeEffectLayer("premiumDust", { intensity: "low" }),
        hero("graduation-cap", { x: 79, y: 50, w: 24, h: 58 }),
        makeTextLayer({ name: "Eyebrow", text: "ENROLLMENT OPEN", styleId: "minimal", size: 2.1, frame: { x: 25, y: 21, w: 38 } }),
        makeTextLayer({ name: "Headline", text: "New Course Launch", styleId: "magazine", size: 5.4, frame: { x: 30, y: 37, w: 52 } }),
        makeTextLayer({ name: "Subhead", text: "IELTS Foundations — 8 weeks, small groups, big results.", styleId: "editorial", size: 2.4, frame: { x: 29, y: 55, w: 48 } }),
        makeComponentLayer("discountCard", { name: "Discount", props: { value: "30%", label: "OFF", caption: "early bird seats" }, size: 2.4, frame: { x: 25, y: 78, w: 22 } }),
        makeComponentLayer("ctaButton", { name: "CTA", props: { label: "Reserve a Seat", style: "gold", action: { type: "internal_route", value: "/portal" } }, size: 3.3, frame: { x: 54, y: 78, w: 20 } }),
      ],
    }),
  },
];

export function getTemplate(templateId) {
  return CAMPAIGN_TEMPLATES.find((t) => t.id === templateId) || null;
}

const templates = { CAMPAIGN_TEMPLATES, getTemplate };
export default templates;
