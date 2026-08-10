/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Petrol ink — a dark with a hue, not a neutral black.
        ink: {
          950: '#070C0E',
          900: '#0B1114',
          850: '#0E171B',
          800: '#111C21',
          750: '#152329',
          700: '#1A2C33',
        },
        line: {
          DEFAULT: '#1E3036',
          soft: '#17272C',
          strong: '#2C464F',
        },
        paper: {
          DEFAULT: '#E7EEEC',
          dim: '#9DB0B4',
          mute: '#697E83',
          faint: '#43575C',
        },
        // The one accent. Retrieval, focus, emphasis. Used sparingly.
        signal: {
          DEFAULT: '#F0A93B',
          dim: '#C08028',
          deep: '#40300F',
        },
        // Reserved exclusively for cache semantics.
        cache: {
          DEFAULT: '#55D6A8',
          dim: '#37A17C',
          deep: '#0F3227',
        },
        // Reserved exclusively for failure.
        alert: {
          DEFAULT: '#E4685B',
          dim: '#A9463C',
          deep: '#391614',
        },
      },
      fontFamily: {
        sans: [
          'ui-sans-serif',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif',
        ],
        serif: ['Newsreader', 'ui-serif', 'Georgia', 'Cambria', 'serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      letterSpacing: {
        micro: '0.14em',
      },
      boxShadow: {
        panel: '0 24px 60px -20px rgba(0, 0, 0, 0.7)',
        inset: 'inset 0 1px 0 0 rgba(255, 255, 255, 0.03)',
      },
      keyframes: {
        caret: {
          '0%, 45%': { opacity: '1' },
          '50%, 95%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        sweep: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(200%)' },
        },
        breathe: {
          '0%, 100%': { opacity: '0.35' },
          '50%': { opacity: '1' },
        },
      },
      animation: {
        caret: 'caret 1.1s steps(1) infinite',
        sweep: 'sweep 1.4s cubic-bezier(0.4, 0, 0.2, 1) infinite',
        breathe: 'breathe 1.8s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
