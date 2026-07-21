import type { Config } from "tailwindcss";

// Palette restricted to the SOP's approved brand colors (section 4.2):
// Sapphire Veil (blue family) and Imperial Topaz (amber family), plus Tailwind's
// default neutral grays for backgrounds/borders and bg-rose-### instead of pure
// red per the SOP's explicit note.
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        sapphireVeil: {
          tint: "#e7f0fa",   // lightest — card/badge backgrounds
          light: "#7ba4d0",  // hover/secondary accents
          DEFAULT: "#2e5e99", // primary brand blue — buttons, links, focus rings
          dark: "#0d2440",    // headings, high-contrast text on light backgrounds
        },
        imperialTopaz: {
          tint: "#fff8e7",   // warning/attention backgrounds
          light: "#ffd77a",  // secondary highlight
          DEFAULT: "#e6a520", // warning/attention accents (e.g. skipped-field badges)
        },
      },
    },
  },
  plugins: [],
};
export default config;
