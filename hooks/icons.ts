// Icons from Lucide (lucide-static 0.468.0, ISC License, https://lucide.dev): the inner shapes of each 24×24 icon.
// An Svg is drawn as an image, so its colour cannot inherit the theme; the stroke follows prefers-color-scheme instead.
const SHAPES = {
  settings:
    '<path d="M20 7h-9" /> <path d="M14 17H5" /> <circle cx="17" cy="17" r="3" /> <circle cx="7" cy="7" r="3" />',
  today:
    '<path d="M8 2v4" /> <path d="M16 2v4" /> <rect width="18" height="18" x="3" y="4" rx="2" /> <path d="M3 10h18" /> <path d="m9 16 2 2 4-4" />',
  list: '<path d="M3 12h.01" /> <path d="M3 18h.01" /> <path d="M3 6h.01" /> <path d="M8 12h13" /> <path d="M8 18h13" /> <path d="M8 6h13" />',
  calendar:
    '<path d="M8 2v4" /> <path d="M16 2v4" /> <rect width="18" height="18" x="3" y="4" rx="2" /> <path d="M3 10h18" /> <path d="M8 14h.01" /> <path d="M12 14h.01" /> <path d="M16 14h.01" /> <path d="M8 18h.01" /> <path d="M12 18h.01" /> <path d="M16 18h.01" />',
  pull: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /> <polyline points="7 10 12 15 17 10" /> <line x1="12" x2="12" y1="15" y2="3" />',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2" /> <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />',
  send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" /> <path d="m21.854 2.147-10.94 10.939" />',
  plus: '<path d="M5 12h14" /> <path d="M12 5v14" />',
  ai: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" /> <path d="M20 3v4" /> <path d="M22 5h-4" /> <path d="M4 17v2" /> <path d="M5 18H3" />',
  redo: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /> <path d="M21 3v5h-5" /> <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /> <path d="M8 16H3v5" />',
  edit: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /> <path d="m15 5 4 4" />',
  expand: '<path d="m6 9 6 6 6-6" />',
  collapse: '<path d="m18 15-6-6-6 6" />',
  trash:
    '<path d="M3 6h18" /> <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /> <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /> <line x1="10" x2="10" y1="11" y2="17" /> <line x1="14" x2="14" y1="11" y2="17" />',
  close: '<path d="M18 6 6 18" /> <path d="m6 6 12 12" />',
  busy: '<path d="M21 12a9 9 0 1 1-6.219-8.56" />',
  open: '<path d="m9 18 6-6-6-6" />',
  back: '<path d="m15 18-6-6 6-6" />',
  minus: '<path d="M5 12h14" />',
  retry: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /> <path d="M3 3v5h5" />',
} as const

export type IconName = keyof typeof SHAPES
export type IconTone = 'muted' | 'danger' | 'accent'

// Light / dark stroke per tone, close to the app's own secondary text, error and Claude colours.
const TONES: Record<IconTone, [string, string]> = {
  muted: ['#57606a', '#b1bac4'],
  danger: ['#cf222e', '#ff7b72'],
  accent: ['#c15f3c', '#e08a68'],
}

// Centred by its box, an icon sits a hair below the button text beside it; the drawing is lifted ~0.7px at 14px.
// The top stroke of the tallest Lucide shapes reaches y=1, so a larger lift starts clipping them.
const NUDGE = 1.25

export const icon = (name: IconName, tone: IconTone = 'muted') => {
  const [light, dark] = TONES[tone]
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 ${NUDGE} 24 24" fill="none" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `<style>svg{stroke:${light}}@media (prefers-color-scheme: dark){svg{stroke:${dark}}}</style>${SHAPES[name]}</svg>`
  )
}
