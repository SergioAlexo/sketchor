const s = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const Logo = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 18L11 5l3.5 6.5L18 6l2 12" {...s} strokeWidth={2.2} />
  </svg>
);
export const Download = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" {...s} />
  </svg>
);
export const Folder = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" {...s} />
  </svg>
);
export const Snap = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 20l6-8 4 4 6-10" {...s} />
    <rect x="17" y="3" width="5" height="5" {...s} strokeWidth={1.6} />
  </svg>
);
export const Ruler = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3 17L17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2" {...s} />
  </svg>
);
export const Check = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="8" {...s} />
    <path d="M8.5 12l2.5 2.5 4.5-5" {...s} />
  </svg>
);
export const Layers = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 3l9 5-9 5-9-5zM3 13l9 5 9-5" {...s} />
  </svg>
);
export const Code = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M9 7l-5 5 5 5M15 7l5 5-5 5" {...s} />
  </svg>
);
export const Cube = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5" {...s} />
  </svg>
);
