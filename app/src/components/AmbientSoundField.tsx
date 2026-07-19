import { useEffect, useRef } from "react";

const POINTS_X = 34;
const POINTS_Z = 18;

export type AmbientMode = "login" | "feed" | "profile" | "compare" | "biometrics";

const MODE_CONFIG: Record<
  AmbientMode,
  {
    primary: string;
    secondary: string;
    centerY: number;
    amplitude: number;
    rowAlpha: number;
    columnAlpha: number;
    pulse: number;
    twist: number;
  }
> = {
  login: {
    primary: "255, 93, 143",
    secondary: "122, 155, 184",
    centerY: 0.54,
    amplitude: 0.9,
    rowAlpha: 0.05,
    columnAlpha: 0.035,
    pulse: 1,
    twist: 0.18,
  },
  feed: {
    primary: "255, 93, 143",
    secondary: "232, 168, 74",
    centerY: 0.6,
    amplitude: 1.2,
    rowAlpha: 0.06,
    columnAlpha: 0.035,
    pulse: 1.25,
    twist: 0.26,
  },
  profile: {
    primary: "122, 155, 184",
    secondary: "255, 93, 143",
    centerY: 0.55,
    amplitude: 0.72,
    rowAlpha: 0.04,
    columnAlpha: 0.055,
    pulse: 0.8,
    twist: -0.12,
  },
  compare: {
    primary: "255, 93, 143",
    secondary: "122, 155, 184",
    centerY: 0.56,
    amplitude: 1.05,
    rowAlpha: 0.07,
    columnAlpha: 0.055,
    pulse: 1.1,
    twist: 0.42,
  },
  biometrics: {
    primary: "232, 168, 74",
    secondary: "255, 93, 143",
    centerY: 0.58,
    amplitude: 0.82,
    rowAlpha: 0.045,
    columnAlpha: 0.075,
    pulse: 1.35,
    twist: 0.04,
  },
};

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export default function AmbientSoundField({ mode = "feed" }: { mode?: AmbientMode }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const modeRef = useRef<AmbientMode>(mode);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    let frame = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let running = true;
    let reducedMotion = prefersReducedMotion();
    let parallaxX = 0;
    let parallaxY = 0;
    let targetParallaxX = 0;
    let targetParallaxY = 0;

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onMotionChange = () => {
      reducedMotion = motionQuery.matches;
    };
    motionQuery.addEventListener("change", onMotionChange);

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (reducedMotion) return;
      targetParallaxX = ((event.clientX / Math.max(width, 1)) - 0.5) * 26;
      targetParallaxY = ((event.clientY / Math.max(height, 1)) - 0.5) * 18;
    };

    const onPointerLeave = () => {
      targetParallaxX = 0;
      targetParallaxY = 0;
    };

    const project = (x: number, y: number, z: number, centerY: number) => {
      const depth = 620;
      const scale = depth / (depth + z);
      return {
        x: width / 2 + parallaxX + x * scale,
        y: height * centerY + parallaxY + y * scale,
        scale,
      };
    };

    const draw = () => {
      if (!running) return;
      frame = reducedMotion ? 120 : frame + 1;
      parallaxX += (targetParallaxX - parallaxX) * 0.045;
      parallaxY += (targetParallaxY - parallaxY) * 0.045;

      ctx.clearRect(0, 0, width, height);

      const t = frame * 0.012;
      const config = MODE_CONFIG[modeRef.current];
      const spacingX = Math.max(42, width / 24);
      const spacingZ = 44;
      const originZ = -180;
      const points: { x: number; y: number; scale: number; glow: number }[][] = [];

      for (let zi = 0; zi < POINTS_Z; zi += 1) {
        const row: { x: number; y: number; scale: number; glow: number }[] = [];
        const z = originZ + zi * spacingZ;
        for (let xi = 0; xi < POINTS_X; xi += 1) {
          const baseX = (xi - (POINTS_X - 1) / 2) * spacingX;
          const x = baseX + Math.sin(zi * 0.42 + t * 0.65) * config.twist * 28;
          const wave =
            Math.sin(xi * 0.42 + t * config.pulse) * 18 * config.amplitude +
            Math.cos(zi * 0.55 - t * 0.8) * 12 * config.amplitude +
            Math.sin((xi + zi) * 0.22 + t * 0.6) * 10 * config.amplitude;
          row.push({
            ...project(x, wave, z, config.centerY),
            glow: (Math.sin(xi * 0.8 + zi * 0.35 + t * 1.4) + 1) / 2,
          });
        }
        points.push(row);
      }

      const horizon = ctx.createRadialGradient(
        width / 2 + parallaxX * 0.35,
        height * (config.centerY - 0.08) + parallaxY * 0.35,
        0,
        width / 2,
        height * (config.centerY - 0.08),
        Math.max(width, height) * 0.62,
      );
      horizon.addColorStop(0, `rgba(${config.primary}, 0.065)`);
      horizon.addColorStop(0.42, `rgba(${config.secondary}, 0.035)`);
      horizon.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = horizon;
      ctx.fillRect(0, 0, width, height);

      ctx.lineWidth = 1;
      for (const row of points) {
        ctx.beginPath();
        row.forEach((point, index) => {
          if (index === 0) ctx.moveTo(point.x, point.y);
          else ctx.lineTo(point.x, point.y);
        });
        ctx.strokeStyle = `rgba(${config.primary}, ${config.rowAlpha})`;
        ctx.stroke();
      }

      for (let xi = 0; xi < POINTS_X; xi += 2) {
        ctx.beginPath();
        points.forEach((row, index) => {
          const point = row[xi];
          if (index === 0) ctx.moveTo(point.x, point.y);
          else ctx.lineTo(point.x, point.y);
        });
        ctx.strokeStyle = `rgba(${config.secondary}, ${config.columnAlpha})`;
        ctx.stroke();
      }

      for (const row of points) {
        for (const point of row) {
          const radius = Math.max(0.45, point.scale * 1.35);
          ctx.beginPath();
          ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
          ctx.fillStyle =
            point.glow > 0.86
              ? `rgba(${config.primary}, 0.24)`
              : "rgba(236, 236, 241, 0.08)";
          ctx.fill();
        }
      }

      if (modeRef.current === "compare") {
        ctx.beginPath();
        const mid = Math.floor(points.length / 2);
        points[mid].forEach((point, index) => {
          const offset = Math.sin(index * 0.5 + t * 1.8) * 9;
          if (index === 0) ctx.moveTo(point.x, point.y + offset);
          else ctx.lineTo(point.x, point.y + offset);
        });
        ctx.strokeStyle = `rgba(${config.secondary}, 0.12)`;
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }

      if (!reducedMotion) requestAnimationFrame(draw);
    };

    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerleave", onPointerLeave);
    draw();

    return () => {
      running = false;
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerleave", onPointerLeave);
      motionQuery.removeEventListener("change", onMotionChange);
    };
  }, []);

  return <canvas ref={canvasRef} className="ambient-sound-field" aria-hidden="true" />;
}
