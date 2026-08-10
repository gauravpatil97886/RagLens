/** Every colour resolves through a CSS variable — see the token block at the
 *  top of src/index.css. Tailwind's `<alpha-value>` placeholder keeps the
 *  opacity modifiers (`bg-signal/10`) working across both themes. */
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // The navigation ground. Ordered *behind* the conversation in both
        // themes, so the reading surface is always the brighter of the two.
        rail: v('rail'),
        // Petrol ink — a dark with a hue, not a neutral black. Inverts to a
        // cool bond paper in light, keeping the same hue through the ramp.
        ink: {
          950: v('ink-950'),
          900: v('ink-900'),
          850: v('ink-850'),
          800: v('ink-800'),
          750: v('ink-750'),
          700: v('ink-700'),
        },
        line: {
          DEFAULT: v('line'),
          soft: v('line-soft'),
          strong: v('line-strong'),
        },
        paper: {
          DEFAULT: v('paper'),
          dim: v('paper-dim'),
          mute: v('paper-mute'),
          faint: v('paper-faint'),
        },
        // The one accent. Retrieval, focus, emphasis. Used sparingly.
        signal: {
          DEFAULT: v('signal'),
          dim: v('signal-dim'),
          deep: v('signal-deep'),
        },
        // Reserved exclusively for cache semantics.
        cache: {
          DEFAULT: v('cache'),
          dim: v('cache-dim'),
          deep: v('cache-deep'),
        },
        // Reserved exclusively for failure.
        alert: {
          DEFAULT: v('alert'),
          dim: v('alert-dim'),
          deep: v('alert-deep'),
        },
        // Text sitting on a filled accent — flips with the theme so the fill
        // can stay saturated in both.
        onaccent: v('onaccent'),
        // Modal and drawer backdrops.
        scrim: v('scrim'),
      },
      fontFamily: {
        // Instrument Sans carries the whole app: chrome, labels and the answers
        // themselves. A neo-grotesque with enough character in its numerals and
        // its `g` to not read as the system default.
        sans: [
          '"Instrument Sans"',
          'ui-sans-serif',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          'sans-serif',
        ],
        // Demoted, deliberately: the serif is now the *document's* voice —
        // retrieved chunk text and the questions the cache has stored. If it is
        // set in Newsreader, a source wrote it, not the model and not the UI.
        serif: ['Newsreader', 'ui-serif', 'Georgia', 'Cambria', 'serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      letterSpacing: {
        micro: '0.14em',
      },
      borderRadius: {
        bubble: '1.25rem',
        composer: '1.5rem',
      },
      boxShadow: {
        panel: 'var(--shadow-panel)',
        lift: 'var(--shadow-lift)',
        inset: 'var(--shadow-inset)',
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
        // A chunk arriving from the ingest stream: it lands lit, then cools.
        land: {
          '0%': { backgroundColor: 'rgb(var(--signal) / 0.20)' },
          '100%': { backgroundColor: 'rgb(var(--signal) / 0)' },
        },
      },
      animation: {
        caret: 'caret 1.1s steps(1) infinite',
        sweep: 'sweep 1.4s cubic-bezier(0.4, 0, 0.2, 1) infinite',
        breathe: 'breathe 1.8s ease-in-out infinite',
        land: 'land 0.75s cubic-bezier(0.16, 1, 0.3, 1) 1',
      },
    },
  },
  plugins: [],
};
