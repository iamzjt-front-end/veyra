import type { SVGProps } from "react";

const paths = {
  arrow: "M5 12h14m-5-5 5 5-5 5",
  chevron: "m9 5 7 7-7 7",
  down: "m6 9 6 6 6-6",
  check: "m5 12 4 4L19 6",
  close: "m6 6 12 12M6 18 18 6",
  pause: "M8 5v14M16 5v14",
  play: "m8 5 11 7-11 7Z",
  stop: "M6 6h12v12H6Z",
  folder: "M3 7V5h6l2 2h10v13H3Zm0 4h18",
  home: "m3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18m0 4v6l4 2",
  runs: "M12 3a9 9 0 1 1-9 9M3 3v6h6m3-2v6l4 2",
  settings:
    "M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Zm3 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
  panel: "M3 4h18v16H3Zm12 0v16",
  external: "M14 3h7v7m0-7L11 13M10 3H3v18h18v-7",
  copy: "M9 8h12v13H9ZM15 8V3H3v13h6",
  code: "m7 6-6 6 6 6m10-12 6 6-6 6M14 3l-4 18",
  file: "M5 3h9l5 5v13H5Zm9 0v5h5",
  warning: "m12 3 10 18H2Zm0 6v5m0 3v1",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 1v3m0 16v3M1 12h3m16 0h3M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2",
  moon: "M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18m0 8v6m0-10v1",
  search: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14m5 12 6 6",
  branch: "M7 3v12a4 4 0 0 0 4 4h6M7 8h7a3 3 0 0 0 3-3V3",
} as const;
export type IconName = keyof typeof paths;
export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
      className={["v-icon", props.className].filter(Boolean).join(" ")}
    >
      <path d={paths[name]} />
    </svg>
  );
}
export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className="v-brand">
      <span className="v-mark" aria-hidden="true">
        <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none">
          <path d="M5 5h5v4H8l4 9 4-9h-2V5h5v4l-7 13L5 9Z" fill="currentColor" />
        </svg>
      </span>
      {!compact && <span>Veyra</span>}
    </span>
  );
}
