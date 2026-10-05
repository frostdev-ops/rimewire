// Project appearance overrides. Clear old values on every reload/project change.
const variables = {
  background: "--bg", surface: "--surface", surfaceAlt: "--surface-2",
  border: "--line", borderSoft: "--line-soft", text: "--text",
  textSecondary: "--text-2", muted: "--muted", accent: "--accent",
  accentSoft: "--accent-soft", focus: "--focus", highlight: "--highlight",
  done: "--c-done", active: "--c-active", spec: "--c-spec",
  planned: "--c-planned", blocked: "--c-blocked", aside: "--c-aside",
  ready: "--c-ready", onSolid: "--on-solid",
};
export function applyAppearance(root, project, prefersDark) {
  const palette = project?.palette || {};
  const mode = palette.mode || "auto";
  const dark = mode === "dark" || (mode === "auto" && prefersDark);
  root.dataset.theme = mode;
  const colors = { ...palette.colors, ...palette[dark ? "dark" : "light"] };
  for (const [key, variable] of Object.entries(variables)) {
    root.style.removeProperty(variable);
    if (colors[key]) root.style.setProperty(variable, colors[key]);
  }
  // Accent overrides should also style keyboard focus and ready indicators.
  if (colors.accent && !colors.focus) root.style.setProperty("--focus", colors.accent);
  if (colors.done && !colors.ready) root.style.setProperty("--c-ready", colors.done);
  for (const key of ["sans", "mono"]) {
    root.style.removeProperty(`--${key}`);
    if (project?.fonts?.[key]) root.style.setProperty(`--${key}`, project.fonts[key]);
  }
}
