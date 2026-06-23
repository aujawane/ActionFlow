import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#ecfdf6",
          100: "#d1fae8",
          200: "#a7f3d5",
          300: "#6ee7bb",
          400: "#34d39c",
          500: "#10b981",
          600: "#069668",
          700: "#047857",
          800: "#065f46",
          900: "#064e3b"
        }
      },
      boxShadow: {
        premium: "0 24px 80px -32px rgba(15, 23, 42, 0.35)",
        glow: "0 18px 50px -28px rgba(6, 150, 104, 0.9)"
      }
    }
  },
  plugins: []
};

export default config;
