import type { ReactElement } from "react";

const PATHS = {
  queue: <><path d="M4 13.5h4.2l1.6 2.5h4.4l1.6-2.5H20"/><path d="M6.6 5.5h10.8a1.5 1.5 0 0 1 1.45 1.1L20 13.5V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18v-4.5l1.15-6.9A1.5 1.5 0 0 1 6.6 5.5z"/></>,
  projects: <><path d="M12 3.8l8.2 4.3L12 12.4 3.8 8.1z"/><path d="M3.8 12.2l8.2 4.3 8.2-4.3"/><path d="M3.8 16.2l8.2 4.3 8.2-4.3"/></>,
  mail: <><rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="M4.5 7.5l7.5 5.5 7.5-5.5"/></>,
  settings: <><circle cx="12" cy="12" r="2.8"/><path d="M18.31 10.07L20.83 10.28L20.83 13.72L18.31 13.93L17.83 15.1L19.46 17.03L17.03 19.46L15.1 17.83L13.93 18.31L13.72 20.83L10.28 20.83L10.07 18.31L8.9 17.83L6.97 19.46L4.54 17.03L6.17 15.1L5.69 13.93L3.17 13.72L3.17 10.28L5.69 10.07L6.17 8.9L4.54 6.97L6.97 4.54L8.9 6.17L10.07 5.69L10.28 3.17L13.72 3.17L13.93 5.69L15.1 6.17L17.03 4.54L19.46 6.97L17.83 8.9z"/></>,
  menu: <><path d="M4 7h16M4 12h16M4 17h10"/></>,
  search: <><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></>,
  back: <><path d="M14.5 5.5L8 12l6.5 6.5"/></>,
  chevR: <><path d="M9.5 6l6 6-6 6"/></>,
  chevD: <><path d="M6.5 9.5l5.5 5.5 5.5-5.5"/></>,
  play: <><path d="M8.5 5.8v12.4L18.5 12z" fill="currentColor"/></>,
  pin: <><path d="M9 3.5h6M10.2 3.5v5L7 12v1.5h10V12l-3.2-3.5v-5M12 13.5v7"/></>,
  plus: <><path d="M12 5v14M5 12h14"/></>,
  send: <><path d="M12 19V5.5M6 11l6-6 6 6"/></>,
  check: <><path d="M5 12.5l4.5 4.5L19 7.5"/></>,
  clock: <><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></>,
  twoway: <><path d="M4 8.5h15M15.5 5l3.5 3.5-3.5 3.5M20 15.5H5M8.5 12L5 15.5 8.5 19"/></>,
  oneway: <><path d="M4 12h15M14 7l5 5-5 5"/></>,
  expand: <><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></>,
  fold: <><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></>,
  external: <><path d="M13.5 4.5h6v6M19.5 4.5L11 13M17 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 4 18.5v-10A1.5 1.5 0 0 1 5.5 7H10"/></>,
  picture: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 9h17M7.5 13h9M7.5 16h5.5"/></>,
  copy: <><rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/></>,
  reply: <><path d="M9.5 5.5L4 11l5.5 5.5"/><path d="M4 11h9.5a6.5 6.5 0 0 1 6.5 6.5v1"/></>,
  page: <><rect x="4" y="3.5" width="16" height="17" rx="2.5"/><path d="M4 8h16M8 12h8M8 15.5h5"/></>,
  file: <><path d="M7 3.5h6.5l4.5 4.5v12.5H7a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 7 3.5z"/><path d="M13.5 3.5V8H18"/></>,
  terminal: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M7.5 9.5l3 2.5-3 2.5M12.5 15h4"/></>,
  alert: <><path d="M12 4l9 15.5H3z"/><path d="M12 10v4.5M12 17.2v.1"/></>,
  lock: <><rect x="5" y="11" width="14" height="9.5" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></>,
  x: <><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></>,
  lane: <><path d="M4.5 6.5h15M4.5 12h15M4.5 17.5h9"/></>,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></>,
  unblock: <><path d="M8 11V8a4 4 0 0 1 7.7-1.5"/><rect x="5" y="11" width="14" height="9.5" rx="2.5"/></>,
  filter: <><path d="M4 6.5h16M7 12h10M10 17.5h4"/></>,
  live: <><circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none"/><path d="M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4"/></>,
  at: <><circle cx="12" cy="12" r="3.5"/><path d="M15.5 12v1.5a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.3 6.7"/></>,
  camera: <><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7H8l1.2-2h5.6L16 7h2.5A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="12.5" r="3.2"/></>,
  more: <><circle cx="5.5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor"/></>,
} satisfies Record<string, ReactElement>;

export type IconName = keyof typeof PATHS;

const SIZE = { md: 20, sm: 16, xs: 14 } as const;

export function Icon({ name, size = "md", className }: { name: IconName; size?: keyof typeof SIZE; className?: string }) {
  const px = SIZE[size];
  return (
    <svg
      className={className}
      width={px}
      height={px}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
