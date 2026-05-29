import type { Config } from 'tailwindcss';
import tokens from './design-tokens.json' assert { type: 'json' };

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // brand semantic tokens
        bg: tokens.colorBg,
        surface: tokens.colorSurface,
        'surface-raised': tokens.colorSurfaceRaised,
        ink: tokens.colorText,
        'ink-muted': tokens.colorTextMuted,
        'ink-dim': tokens.colorTextDim,
        accent: tokens.colorAccent,
        'accent-hover': tokens.colorAccentHover,
        'accent-active': tokens.colorAccentActive,
        magenta: tokens.colorMagenta,
        'magenta-bright': tokens.colorMagentaBright,
        line: tokens.colorLine,
        'line-strong': tokens.colorLineStrong,
        success: tokens.colorSuccess,
        error: tokens.colorError,
        cyan: tokens.colorCyan,
        violet: tokens.colorViolet,
        // legacy aliases so pre-existing classes keep working during migration
        primary: tokens.colorAccent,
        'primary-ink': tokens.colorText,
        muted: tokens.colorTextDim,
      },
      backgroundImage: {
        brand: `linear-gradient(135deg, ${tokens.colorMagenta} 0%, ${tokens.colorAccent} 100%)`,
      },
      boxShadow: {
        glow: `0 0 0 1px ${tokens.colorAccent}55, 0 8px 30px -8px ${tokens.colorMagenta}66`,
      },
      fontFamily: {
        sans: tokens.fontBody.split(',').map(s => s.trim()),
        heading: tokens.fontHeading.split(',').map(s => s.trim()),
      },
      borderRadius: { btn: tokens.btnRadius },
    },
  },
} satisfies Config;
