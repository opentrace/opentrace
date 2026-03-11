const THEME_KEY = "ot_theme";
const MODE_KEY = "ot_mode";

export const THEMES = [
  { value: "clean", label: "Clean" },
  { value: "default", label: "Default" },
  { value: "amethyst-haze", label: "Amethyst Haze" },
  { value: "sunset-horizon", label: "Sunset Horizon" },
  { value: "tangerine", label: "Tangerine" },
  { value: "emerald", label: "Emerald" },
  { value: "midnight-tokyo", label: "Midnight Tokyo" },
] as const;

export function loadTheme(): string {
  return localStorage.getItem(THEME_KEY) ?? "clean";
}

export function loadMode(): "light" | "dark" {
  return (localStorage.getItem(MODE_KEY) as "light" | "dark") ?? "dark";
}

export function applyTheme(theme: string) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
}

export function applyMode(mode: "light" | "dark") {
  document.documentElement.dataset.mode = mode;
  localStorage.setItem(MODE_KEY, mode);
}

// Apply saved theme + mode immediately on module load (before first paint)
applyTheme(loadTheme());
applyMode(loadMode());
