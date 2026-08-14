import React, { useEffect, useRef } from "react";
import { usePrefersReducedMotion } from "../hooks/useMediaQuery";

/**
 * Performance-optimized starfield + shooting stars + orbs.
 *
 *  - Caps DPR to 1.5 to keep canvas pixel work cheap on retina mobile.
 *  - Scales star count by viewport (≈ 80 on mobile, ~180 on desktop).
 *  - Pauses RAF when the tab is hidden — saves battery on mobile.
 *  - Disables mouse-parallax on touch / reduced-motion devices.
 */
export default function BackgroundFx() {
  const canvasRef = useRef(null);
  const mouseRef = useRef({ x: 0, y: 0, tx: 0, ty: 0 });
  const reduce = usePrefersReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let stars = [];
    let shooters = [];
    let raf = 0;
    let w = 0,
      h = 0;
    let nextShooterAt = 0;
    let running = !document.hidden;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const isCoarse = window.matchMedia("(pointer: coarse)").matches;

    const HUES = [185, 195, 270, 285, 320, 335, 50, 95];
    const pickHue = () => HUES[Math.floor(Math.random() * HUES.length)];

    const resize = () => {
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // mobile: ~80 stars cap, desktop: ~180 cap, scaled by viewport area
      const cap = w < 640 ? 80 : 180;
      const count = Math.min(cap, Math.floor((w * h) / 14000));
      stars = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        z: 0.3 + Math.random() * 0.7,
        r: 0.3 + Math.random() * 1.4,
        tw: Math.random() * Math.PI * 2,
        twSpeed: 0.005 + Math.random() * 0.022,
        hue: pickHue(),
      }));
      nextShooterAt = performance.now() + 1500 + Math.random() * 2500;
    };

    const onMove = (e) => {
      mouseRef.current.tx = (e.clientX / window.innerWidth - 0.5) * 22;
      mouseRef.current.ty = (e.clientY / window.innerHeight - 0.5) * 22;
    };

    const spawnShooter = () => {
      const fromLeft = Math.random() > 0.5;
      const y = Math.random() * h * 0.6;
      const speed = 6 + Math.random() * 5;
      const angle = (fromLeft ? 1 : -1) * (0.18 + Math.random() * 0.12);
      shooters.push({
        x: fromLeft ? -40 : w + 40,
        y,
        vx: (fromLeft ? 1 : -1) * speed,
        vy: speed * Math.tan(angle),
        life: 0,
        maxLife: 60 + Math.random() * 30,
        hue: pickHue(),
      });
    };

    const draw = () => {
      if (!running) {
        raf = 0;
        return;
      }
      mouseRef.current.x += (mouseRef.current.tx - mouseRef.current.x) * 0.04;
      mouseRef.current.y += (mouseRef.current.ty - mouseRef.current.y) * 0.04;
      const mx = mouseRef.current.x;
      const my = mouseRef.current.y;
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";
      for (const s of stars) {
        s.tw += s.twSpeed;
        const alpha = 0.35 + Math.sin(s.tw) * 0.45;
        const px = s.x + mx * s.z;
        const py = s.y + my * s.z;
        const radius = s.r * s.z;
        const grd = ctx.createRadialGradient(px, py, 0, px, py, radius * 6);
        grd.addColorStop(0, `hsla(${s.hue}, 100%, 75%, ${alpha * s.z * 0.7})`);
        grd.addColorStop(1, `hsla(${s.hue}, 100%, 60%, 0)`);
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(px, py, radius * 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `hsla(${s.hue}, 100%, 90%, ${alpha * s.z})`;
        ctx.beginPath();
        ctx.arc(px, py, radius, 0, Math.PI * 2);
        ctx.fill();
        s.y += s.twSpeed * 4;
        if (s.y > h + 4) {
          s.y = -4;
          s.x = Math.random() * w;
        }
      }
      const now = performance.now();
      if (now > nextShooterAt) {
        spawnShooter();
        nextShooterAt = now + 2000 + Math.random() * 4000;
      }
      shooters = shooters.filter((sh) => {
        sh.life += 1;
        sh.x += sh.vx;
        sh.y += sh.vy;
        const t = sh.life / sh.maxLife;
        if (t >= 1) return false;
        const fade = Math.sin(t * Math.PI);
        const tailLen = 90;
        const tx = sh.x - sh.vx * (tailLen / Math.hypot(sh.vx, sh.vy));
        const ty = sh.y - sh.vy * (tailLen / Math.hypot(sh.vx, sh.vy));
        const grad = ctx.createLinearGradient(sh.x, sh.y, tx, ty);
        grad.addColorStop(0, `hsla(${sh.hue}, 100%, 85%, ${fade})`);
        grad.addColorStop(1, `hsla(${sh.hue}, 100%, 60%, 0)`);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.6;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(sh.x, sh.y);
        ctx.lineTo(tx, ty);
        ctx.stroke();
        ctx.fillStyle = `hsla(${sh.hue}, 100%, 95%, ${fade})`;
        ctx.beginPath();
        ctx.arc(sh.x, sh.y, 1.6, 0, Math.PI * 2);
        ctx.fill();
        return true;
      });
      ctx.globalCompositeOperation = "source-over";
      raf = requestAnimationFrame(draw);
    };

    const onVis = () => {
      running = !document.hidden;
      if (running && !raf) raf = requestAnimationFrame(draw);
    };

    resize();
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVis);
    if (!reduce && !isCoarse) {
      window.addEventListener("mousemove", onMove);
    }
    if (!reduce) {
      raf = requestAnimationFrame(draw);
    } else {
      draw();
    }
    return () => {
      cancelAnimationFrame(raf);
      raf = 0;
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMove);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [reduce]);

  return (
    <div className="fixed inset-0 -z-10 overflow-hidden pointer-events-none" aria-hidden>
      <div className="orb orb-cyan" />
      <div className="orb orb-magenta" />
      <div className="orb orb-violet" />
      {/* extra orbs only on larger screens */}
      <div className="hidden sm:block orb orb-lime" />
      <div className="hidden sm:block orb orb-coral" />
      <div className="bg-grid" />
      <canvas ref={canvasRef} className="absolute inset-0" />
      <div className="aurora-wave" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_45%,rgba(0,0,0,0.6)_100%)]" />
    </div>
  );
}
