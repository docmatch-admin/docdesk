/** ไอคอนเส้นแบบ inline SVG ใช้แทน emoji ในหน้าเจ้าหน้าที่ ใส่ aria-label ที่ปุ่ม ไม่ใช่ที่ไอคอน */
const PATHS = {
  chat: "M4 5h16v11H9l-5 4z",
  calendar: "M5 5h14v15H5zM5 10h14M9 3v4M15 3v4",
  chart: "M5 20V10M12 20V4M19 20v-7",
  book: "M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM8 4v13",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  users: "M16 20v-2a4 4 0 0 0-8 0v2M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  lock: "M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3",
  unlock: "M6 11h12v9H6zM9 11V8a3 3 0 0 1 5.8-1",
  settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2",
  chevronLeft: "M15 6l-6 6 6 6",
  check: "M5 12l5 5 9-10",
  pencil: "M4 20h4L19 9l-4-4L4 16zM13 7l4 4",
  x: "M6 6l12 12M18 6L6 18",
  plus: "M12 5v14M5 12h14",
  send: "M4 12l16-8-6 16-3-7z",
  reopen: "M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4",
  split: "M6 4v6a4 4 0 0 0 4 4h8M14 10l4 4-4 4M6 20v-2",
  message: "M4 5h16v11H9l-5 4zM8 9h8M8 12h5",
  printer: "M7 9V4h10v5M7 17H5v-8h14v8h-2M7 14h10v6H7z",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={className}>
      <path d={PATHS[name]} />
    </svg>
  );
}
