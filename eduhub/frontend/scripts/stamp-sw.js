#!/usr/bin/env node
// stamp-sw.js — post-build step (wired into `yarn build`).
//
// Replaces the __SW_BUILD_ID__ token in build/sw.js with a release id
// derived from the asset manifest + the SW source itself, so:
//   • ANY change to the JS/CSS bundles OR to sw.js produces a NEW id
//   • cache names (eduhub-shell/static/runtime-<id>) are unique per release
//   • the SW `activate` handler therefore deletes every previous release's
//     caches — the exact mechanism that was broken when sw.js bytes were
//     deployed without bumping the hand-maintained SW_VERSION string
//     (root cause of the "PWA reverts to old version" incident).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const buildDir = path.join(__dirname, "..", "build");
const swPath = path.join(buildDir, "sw.js");
const manifestPath = path.join(buildDir, "asset-manifest.json");

if (!fs.existsSync(swPath)) {
  console.error("FATAL: build/sw.js not found — run after `craco build`.");
  process.exit(1);
}

const sw = fs.readFileSync(swPath, "utf8");
if (!sw.includes("__SW_BUILD_ID__")) {
  console.error("FATAL: __SW_BUILD_ID__ token missing from build/sw.js — was public/sw.js edited?");
  process.exit(1);
}

const manifest = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, "utf8") : "";
const hash = crypto.createHash("sha1").update(manifest).update(sw).digest("hex").slice(0, 12);
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const buildId = `v1.9.0-${hash}-${stamp}`;

fs.writeFileSync(swPath, sw.replace(/__SW_BUILD_ID__/g, buildId));
console.log(`stamp-sw: build/sw.js SW_VERSION -> ${buildId}`);
