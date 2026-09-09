import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
/** Fixed-row windowing, updated only by scroll/keyboard input. No observer or idle timer. */
export function VirtualList<T>({
  items,
  rowHeight,
  label,
  itemKey,
  render,
}: {
  items: T[];
  rowHeight: number;
  label: string;
  itemKey: (item: T) => string;
  render: (item: T) => ReactNode;
}) {
  const viewport = useRef<HTMLElement>(null),
    focusIndex = useRef<number | undefined>(undefined);
  const [offset, setOffset] = useState(0);
  const height = Math.min(items.length, 8) * rowHeight;
  const first = Math.max(0, Math.min(items.length - 14, Math.floor(offset / rowHeight) - 3)),
    end = Math.min(items.length, first + 14);
  useLayoutEffect(() => {
    if (focusIndex.current === undefined) return;
    viewport.current
      ?.querySelector<HTMLElement>(`[data-virtual-index="${focusIndex.current}"] button`)
      ?.focus({ preventScroll: true });
    focusIndex.current = undefined;
  });
  return (
    <section
      ref={viewport}
      className="v-virtual-list"
      aria-label={label}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need a focusable virtual scroll viewport.
      tabIndex={0}
      style={{ height }}
      onScroll={(event) => setOffset(event.currentTarget.scrollTop)}
      onKeyDown={(event) => {
        if (
          !["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"].includes(event.key) ||
          !items.length
        )
          return;
        event.preventDefault();
        const index = Number(
          (event.target as HTMLElement).closest<HTMLElement>("[data-virtual-index]")?.dataset
            .virtualIndex ?? Math.floor(offset / rowHeight),
        );
        const target = Math.max(
          0,
          Math.min(
            items.length - 1,
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? items.length - 1
                : index +
                  (event.key === "ArrowDown"
                    ? 1
                    : event.key === "ArrowUp"
                      ? -1
                      : event.key === "PageDown"
                        ? 8
                        : -8),
          ),
        );
        const top = target * rowHeight;
        focusIndex.current = target;
        event.currentTarget.scrollTop = top;
        setOffset(event.currentTarget.scrollTop);
        // Home/End can keep the same offset. Focus immediately when that row is already mounted.
        const button = event.currentTarget.querySelector<HTMLElement>(
          `[data-virtual-index="${target}"] button`,
        );
        if (button) {
          button.focus({ preventScroll: true });
          focusIndex.current = undefined;
        }
      }}
    >
      <ul
        style={{
          height: items.length * rowHeight,
          position: "relative",
          listStyle: "none",
          padding: 0,
          margin: 0,
        }}
      >
        {items.slice(first, end).map((item, index) => (
          <li
            aria-setsize={items.length}
            aria-posinset={first + index + 1}
            data-virtual-index={first + index}
            key={itemKey(item)}
            className="v-virtual-row"
            style={{
              height: rowHeight,
              position: "absolute",
              top: (first + index) * rowHeight,
              width: "100%",
            }}
          >
            {render(item)}
          </li>
        ))}
      </ul>
    </section>
  );
}
