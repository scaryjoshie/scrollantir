import type { Config } from 'tailwindcss';

const withVar = (v: string) => `rgb(var(${v}) / <alpha-value>)`;

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'ui-sans-serif',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Inter',
          'Helvetica',
          'Arial',
          'sans-serif',
        ],
        mono: [
          '"SFMono-Regular"',
          'ui-monospace',
          'Menlo',
          'Consolas',
          'monospace',
        ],
      },
      colors: {
        ink: {
          DEFAULT: withVar('--c-ink'),
          muted: withVar('--c-ink-muted'),
          subtle: withVar('--c-ink-subtle'),
        },
        paper: {
          DEFAULT: withVar('--c-paper'),
          soft: withVar('--c-paper-soft'),
          panel: withVar('--c-paper-panel'),
          hover: withVar('--c-paper-hover'),
        },
        line: {
          DEFAULT: withVar('--c-line'),
          strong: withVar('--c-line-strong'),
        },
        accent: {
          DEFAULT: withVar('--c-accent'),
          soft: withVar('--c-accent-soft'),
        },
        danger: {
          DEFAULT: withVar('--c-danger'),
          soft: withVar('--c-danger-soft'),
        },
        success: {
          DEFAULT: withVar('--c-success'),
          soft: withVar('--c-success-soft'),
        },
        warning: {
          DEFAULT: withVar('--c-warning'),
          soft: withVar('--c-warning-soft'),
        },
        lane: {
          mac: '#6B8EF2',
          phone: '#7DB98A',
          location: '#C79BD8',
        },
      },
      fontSize: {
        xs: ['11px', { lineHeight: '1.4' }],
        sm: ['13px', { lineHeight: '1.5' }],
        base: ['14px', { lineHeight: '1.55' }],
        lg: ['16px', { lineHeight: '1.5' }],
        xl: ['19px', { lineHeight: '1.4' }],
        '2xl': ['24px', { lineHeight: '1.3' }],
        '3xl': ['32px', { lineHeight: '1.2' }],
      },
      borderRadius: {
        card: '8px',
      },
      boxShadow: {
        card: '0 1px 2px rgba(15,15,15,0.04)',
        pop: '0 4px 24px rgba(15,15,15,0.08)',
      },
    },
  },
  plugins: [],
};

export default config;
