"use client";

import { motion } from "framer-motion";

type Props = {
  size?: number;
  className?: string;
  glow?: boolean;
  animate?: boolean;
};

// Twisted-ribbon "D" mark rendered as layered SVG paths with the brand gradient.
export function DistortLogo({ size = 64, className, glow = true, animate = false }: Props) {
  return (
    <motion.div
      className={className}
      style={{ width: size, height: size }}
      initial={animate ? { opacity: 0, scale: 0.8, rotate: -12 } : false}
      animate={animate ? { opacity: 1, scale: 1, rotate: 0 } : undefined}
      transition={{ type: "spring", stiffness: 120, damping: 14 }}
    >
      <svg
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg" shapeRendering="geometricPrecision"
        className={glow ? "logo-glow" : ""}
        style={{ width: "100%", height: "100%" }}
      >
        <defs>
          <linearGradient id="distortFront" x1="10" y1="8" x2="90" y2="92" gradientUnits="userSpaceOnUse">
            <stop stopColor="#5cf2ff" />
            <stop offset="0.45" stopColor="#00f0ff" />
            <stop offset="0.75" stopColor="#2962ff" />
            <stop offset="1" stopColor="#8b5cf6" />
          </linearGradient>
          <linearGradient id="distortBack" x1="20" y1="20" x2="80" y2="80" gradientUnits="userSpaceOnUse">
            <stop stopColor="#0055ff" />
            <stop offset="1" stopColor="#6d28d9" />
          </linearGradient>
          <filter id="distortGlow2" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="1.4" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <g filter="url(#distortGlow2)">
          <path
            d="M30 22 C58 22 76 30 76 50 C76 70 58 78 30 78 L30 64 C46 64 58 60 58 50 C58 40 46 36 30 36 L30 22 Z"
            fill="url(#distortBack)"
            opacity="0.85"
          />
          <path
            d="M30 22 C58 22 76 30 76 50 C76 70 58 78 30 78 L30 64 C46 64 58 60 58 50 C58 40 46 36 30 36 L30 22 Z"
            fill="url(#distortFront)"
          />
          <path d="M34 26 L52 26 L40 50 L24 50 L34 26 Z" fill="#5cf2ff" opacity="0.55" />
          <path d="M48 70 L72 70 L60 50 L44 50 L48 70 Z" fill="#050814" opacity="0.55" />
          <path d="M33 24 C50 24 64 28 70 40" stroke="#ffffff" strokeWidth="1.4" opacity="0.7" strokeLinecap="round" />
        </g>
      </svg>
    </motion.div>
  );
}

export function DistortWordmark({
  size = 36,
  showTagline = false,
  className,
}: {
  size?: number;
  showTagline?: boolean;
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-3 ${className ?? ""}`}>
      <DistortLogo size={size} />
      <div className="flex flex-col leading-none">
        <span className="font-display text-xl font-extrabold tracking-[0.18em] text-white">
          DIST<span className="text-gradient-cyan">O</span>RT
        </span>
        {showTagline && (
          <span className="font-tech text-[10px] uppercase tracking-[0.34em] text-muted-foreground mt-1">
            Freedom Beyond Borders
          </span>
        )}
      </div>
    </div>
  );
}
