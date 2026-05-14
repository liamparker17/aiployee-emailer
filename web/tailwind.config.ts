import type { Config } from 'tailwindcss';
import tokens from './design-tokens.json' assert { type: 'json' };

function rgb(v: string): string { return v; }

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: rgb(tokens.colorBg),
        ink: rgb(tokens.colorText),
        primary: rgb(tokens.colorPrimary),
        'primary-ink': rgb(tokens.colorPrimaryText),
        muted: 'rgb(100, 116, 139)',
        line: 'rgb(226, 232, 240)',
        surface: 'rgb(248, 250, 252)',
      },
      fontFamily: {
        sans: tokens.fontBody.split(',').map(s => s.trim()),
        heading: tokens.fontHeading.split(',').map(s => s.trim()),
      },
      borderRadius: { btn: tokens.btnRadius },
    },
  },
} satisfies Config;
