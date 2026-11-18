// Theme override shared by the pre-paint script (app/layout.tsx) and the
// header toggle (components/ThemeToggle.tsx). "system" is stored as the
// absence of the key, so the CSS media query in globals.css decides.
export type Theme = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "theme";

// Runs synchronously in <head> before first paint, so a saved light/dark
// choice never flashes the device theme first. Anything else = system.
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`;
