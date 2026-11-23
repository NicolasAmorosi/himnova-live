import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@renderer/lib/utils";
import { isPointerFocused } from "@renderer/lib/focus-modality";

/** Rows kept mounted above and below the viewport, so a fast scroll shows
 *  tiles rather than blank space while the next frame is computed. */
const OVERSCAN_ROWS = 2;

/**
 * How the column count is decided — the two are mutually exclusive on purpose.
 *
 * `minItemWidth` is the `minmax(Npx,1fr)` + `auto-fill` behaviour: as many
 * columns as fit. `columns` pins the count regardless of how wide the panel
 * is, which is what a deck's grid needs — two slides across, each big enough
 * to actually read from the booth, is a deliberate layout decision and not a
 * consequence of the column being narrow that day.
 */
type ColumnSizing =
  | { columns: number; minItemWidth?: undefined }
  | { columns?: undefined; minItemWidth: number };

type VirtualGridBaseProps<T> = {
  /** Accessible name for the grid as a whole (it is a `role="list"`). */
  "aria-label": string;
  className?: string;
  /** Gap between tiles, in px, on both axes. Also the value used to work out
   *  how many columns fit, so it must match what is actually rendered — hence
   *  a number rather than a Tailwind class. */
  gap: number;
  /** Total height of one tile in px, given the column width the grid settled
   *  on. A function because a tile is usually an aspect-ratio box plus a
   *  fixed-height label (see `THUMB_TILE_LABEL_PX`), so its height depends on
   *  how wide the column ended up. */
  itemHeight: (columnWidth: number) => number;
  itemKey: (item: T, index: number) => string | number;
  items: readonly T[];
  /** Fired (by row, not by pixel) whenever the mounted window changes. The
   *  library grid feeds this to `deck:prewarm` so only what is actually on
   *  screen gets pre-converted. `end` is exclusive. */
  onVisibleRangeChange?: (range: { start: number; end: number }) => void;
  /** `tabIndex` implements the roving tabindex: exactly one item in the whole
   *  grid is 0, every other is -1. Spread it onto the item's focusable
   *  element (`ThumbTile` takes a `tabIndex` prop for this). */
  renderItem: (item: T, index: number, opts: { tabIndex: number }) => ReactNode;
  /**
   * The item this grid should keep in view on its own — the slide that is on
   * the projector, the verse the preview cursor is on. Scrolled to (no more
   * than `block: "nearest"` does: nothing moves while it is already visible)
   * whenever the VALUE changes, never on a re-render, so the operator's own
   * scroll survives until the followed item actually moves.
   *
   * It exists because virtualizing makes "the grid doesn't follow" a
   * different problem than it was: an off-window tile is no longer just
   * out of sight, it is not rendered at all, and a deck on auto-advance
   * would leave the grid sitting on a part of the service that is over.
   */
  scrollToIndex?: number | null;
};

type VirtualGridProps<T> = VirtualGridBaseProps<T> & ColumnSizing;

/**
 * Renders only the rows near the viewport, for grids that can hold hundreds of
 * tiles (a linked folder with 600 presentations).
 *
 * **It has no scroller of its own** — it measures and listens to the nearest
 * scrollable ancestor instead. In this app that ancestor is `PanelBody`, which
 * is also the drop target for files dragged in from the OS: nesting a second
 * scroller inside it would give the panel two scrollbars and, worse, would put
 * the tiles outside the element whose `onDrop` handles the import. Everything
 * here bubbles, so the existing drag & drop keeps working untouched.
 *
 * Accessibility is not a follow-up here, it is part of the same change:
 * virtualizing without it makes keyboard navigation *worse* than the plain
 * grid it replaces. Hence `aria-setsize`/`aria-posinset` (so a screen reader
 * is told there are 600 items even though 30 are mounted), a roving tabindex
 * (one Tab enters the grid instead of 600 Tabs crossing it), arrow-key
 * movement, and keeping the focused item mounted even when it scrolls out of
 * the window — otherwise focus silently falls back to `<body>` mid-scroll.
 */
export function VirtualGrid<T>({
  "aria-label": ariaLabel,
  className,
  columns: fixedColumns,
  gap,
  itemHeight,
  itemKey,
  items,
  minItemWidth,
  onVisibleRangeChange,
  renderItem,
  scrollToIndex = null,
}: VirtualGridProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollParentRef = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  const [rowWindow, setRowWindow] = useState({ startRow: 0, endRow: 0 });
  const [focusedIndex, setFocusedIndex] = useState(0);
  /** Only a keyboard move should pull DOM focus; re-rendering for any other
   *  reason must never steal it from wherever the operator actually is. */
  const pendingFocusRef = useRef(false);
  /** The dev-only height assertion below fires at most once per grid. */
  const warnedRef = useRef(false);
  /** Column width the dev geometry assertion below has already measured at.
   *  The check reads layout, so it must not run on every row crossing. */
  const checkedColumnWidthRef = useRef<number | null>(null);

  // `measured` is not the same thing as "has items": until the container's
  // real width is known there is no honest column count, and guessing one
  // (falling back to `minItemWidth`) paints a single full-width column of
  // tiles whose height was computed for a much narrower one. Nothing is
  // rendered until the layout effect below has measured, which happens before
  // the first paint.
  const measured = width > 0;
  const columns = useMemo(() => {
    if (fixedColumns !== undefined) return Math.max(1, fixedColumns);
    if (minItemWidth === undefined || width <= 0) return 1;
    return Math.max(1, Math.floor((width + gap) / (minItemWidth + gap)));
  }, [fixedColumns, gap, minItemWidth, width]);
  const columnWidth = measured ? (width - gap * (columns - 1)) / columns : 0;
  const rowHeight = measured ? itemHeight(columnWidth) + gap : 0;
  const rowCount = measured ? Math.ceil(items.length / columns) : 0;
  // No trailing gap after the last row, so the panel doesn't scroll past the
  // content by one gap's worth of nothing.
  const totalHeight = rowCount > 0 ? rowCount * rowHeight - gap : 0;

  // Resolve the scrolling ancestor once mounted, and track our own width.
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    scrollParentRef.current = findScrollParent(element);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    setWidth(element.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  /** Re-reads the container's width and stores it if it really changed.
   *
   *  The `ResizeObserver` is the primary source, but it cannot be the only
   *  one: this grid's own height decides whether the scrolling ancestor shows
   *  a scrollbar, and that scrollbar changes this grid's width — a genuine
   *  observer loop, and Chrome resolves those by dropping notifications. The
   *  symptom is a width stuck at its pre-scrollbar value, which quietly feeds
   *  a slightly-too-wide column into `itemHeight`. Reading it again on every
   *  recompute (mount, resize, scroll) makes that self-correcting. */
  const syncWidth = useCallback(() => {
    const element = containerRef.current;
    if (!element) return;
    const actual = element.clientWidth;
    setWidth((current) => (Math.abs(current - actual) < 0.5 ? current : actual));
  }, []);

  const recomputeWindow = useCallback(() => {
    const element = containerRef.current;
    const scroller = scrollParentRef.current;
    if (!element) return;
    syncWidth();
    if (rowHeight <= 0) return;

    if (!scroller) {
      // No scrollable ancestor (a short list, an unexpected layout): mount
      // everything rather than guess a viewport and render nothing.
      setRowWindow((current) =>
        current.startRow === 0 && current.endRow === rowCount ? current : { startRow: 0, endRow: rowCount },
      );
      return;
    }

    // How far the grid's own top sits below the scroller's visible top.
    const offsetTop = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const firstVisibleRow = Math.floor(Math.max(0, -offsetTop) / rowHeight);
    const visibleRows = Math.ceil(scroller.clientHeight / rowHeight) + 1;
    const startRow = Math.max(0, firstVisibleRow - OVERSCAN_ROWS);
    const endRow = Math.min(rowCount, firstVisibleRow + visibleRows + OVERSCAN_ROWS);

    // Only a row boundary is a real change — scrolling within one row must not
    // re-render several hundred tiles' worth of React work.
    setRowWindow((current) =>
      current.startRow === startRow && current.endRow === endRow ? current : { startRow, endRow },
    );
  }, [rowCount, rowHeight, syncWidth]);

  useLayoutEffect(() => {
    recomputeWindow();
  }, [recomputeWindow]);

  /** Always the newest `recomputeWindow`, so the scroll listener below can be
   *  attached once instead of being torn down and re-attached every time the
   *  callback's identity changes — which is every width or row-count change,
   *  i.e. continuously while a panel is being resized. */
  const recomputeRef = useRef(recomputeWindow);
  recomputeRef.current = recomputeWindow;

  useEffect(() => {
    // `scrollParentRef` is resolved by the layout effect above, which runs
    // before this one on the mount commit.
    const scroller = scrollParentRef.current;
    if (!scroller) return;
    let frame = 0;
    const onScroll = () => {
      // The handler itself does nothing but ask for a frame: scroll events
      // fire far more often than 60 Hz, and the measurement below reads
      // layout.
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        recomputeRef.current();
      });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, []);

  // A shrinking list must never leave the roving tabindex pointing past the end.
  useEffect(() => {
    setFocusedIndex((current) => Math.min(current, Math.max(0, items.length - 1)));
  }, [items.length]);

  useEffect(() => {
    onVisibleRangeChange?.({
      start: rowWindow.startRow * columns,
      end: Math.min(items.length, rowWindow.endRow * columns),
    });
  }, [columns, items.length, onVisibleRangeChange, rowWindow.endRow, rowWindow.startRow]);

  const scrollIndexIntoView = useCallback(
    (index: number) => {
      const element = containerRef.current;
      const scroller = scrollParentRef.current;
      if (!element || !scroller) return;
      const row = Math.floor(index / columns);
      const offsetTop = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      const rowTop = offsetTop + row * rowHeight;
      if (rowTop < 0) scroller.scrollTop += rowTop;
      else if (rowTop + rowHeight > scroller.clientHeight) {
        scroller.scrollTop += rowTop + rowHeight - scroller.clientHeight;
      }
    },
    [columns, rowHeight],
  );

  function moveFocus(nextIndex: number) {
    const clamped = Math.max(0, Math.min(items.length - 1, nextIndex));
    pendingFocusRef.current = true;
    setFocusedIndex(clamped);
    scrollIndexIntoView(clamped);
    // Recompute the mounted window HERE, against the scroll position that was
    // just written, rather than leaving it to the scroll event's own frame.
    //
    // Measured (End on a 176-verse chapter): without this the move lands in
    // two commits, and the target tile is mounted by a DIFFERENT block in each
    // — the out-of-window fallback first, the main window after the scroll
    // frame. React unmounts the node it focused and mounts a new one, so focus
    // falls to <body> a frame after arriving, with `pendingFocusRef` already
    // spent. Both state updates batch into one commit this way, and the tile
    // that gets focus is the one that stays.
    recomputeWindow();
  }

  /** The index this grid last scrolled itself to. Compared against, rather
   *  than recomputed, so a resize or a re-render never re-scrolls: only the
   *  followed item moving does. */
  const followedRef = useRef<number | null>(null);

  useEffect(() => {
    // Nothing to follow, nothing to follow it to, or the geometry isn't known
    // yet — in the last case this effect runs again the moment it is, because
    // `rowHeight` is a dependency.
    if (scrollToIndex === null || items.length === 0 || rowHeight <= 0) return;
    const target = Math.max(0, Math.min(items.length - 1, scrollToIndex));
    if (followedRef.current === target) return;
    followedRef.current = target;
    scrollIndexIntoView(target);
  }, [items.length, rowHeight, scrollIndexIntoView, scrollToIndex]);

  /** Keeps the roving tabindex on whatever actually holds focus, however it
   *  got there. Without this a click on the 50th tile would leave the rover on
   *  the 1st, and the next arrow key would jump back to the top of the grid
   *  instead of stepping from where the operator is. */
  function handleFocusCapture(event: React.FocusEvent<HTMLDivElement>) {
    const owner = event.target.closest<HTMLElement>("[data-virtual-index]");
    const index = Number(owner?.dataset.virtualIndex);
    if (Number.isInteger(index)) setFocusedIndex(index);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (items.length === 0) return;
    // On a tile the MOUSE focused, the arrows are the operator's shortcuts
    // (←/→ move what is live, ↑/↓ move PREVIEW), same as on any other clicked
    // button — taking them here left → dead on the projector right after
    // clicking a slide. Reached with Tab or the arrows, they walk the grid.
    if (event.key.startsWith("Arrow") && isPointerFocused(event.target)) return;
    const moves: Record<string, number | undefined> = {
      ArrowRight: focusedIndex + 1,
      ArrowLeft: focusedIndex - 1,
      ArrowDown: focusedIndex + columns,
      ArrowUp: focusedIndex - columns,
      Home: 0,
      End: items.length - 1,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    moveFocus(next);
  }

  // The grid positions rows against `itemHeight`, so a tile that renders any
  // other height leaves every row after the first slightly off — a defect that
  // is easy to see and hard to attribute. In dev, say it out loud once instead
  // of letting it show up as a ragged grid.
  useEffect(() => {
    if (!import.meta.env.DEV || !measured || warnedRef.current) return;
    // Once per distinct column width, not once per row crossing. The read
    // below forces a layout, and with correct geometry nothing ever set
    // `warnedRef` — so this ran, forever, every time the operator scrolled
    // past a row boundary. A new column width is the only thing that can
    // change the answer.
    if (checkedColumnWidthRef.current === columnWidth) return;
    const tile = containerRef.current?.querySelector<HTMLElement>("[data-virtual-index] > *");
    if (!tile) return;
    checkedColumnWidthRef.current = columnWidth;
    const actual = tile.getBoundingClientRect().height;
    const expected = rowHeight - gap;
    if (Math.abs(actual - expected) > 1) {
      warnedRef.current = true;
      console.warn(
        `[VirtualGrid] "${ariaLabel}": itemHeight() says ${expected}px at a ${columnWidth}px column, ` +
          `but the tile renders ${actual}px. Rows are positioned against the former, so they will drift.`,
      );
    }
  }, [ariaLabel, columnWidth, gap, measured, rowHeight, rowWindow]);

  // Moves real DOM focus after the target row has been mounted by the render
  // that `moveFocus` triggered — doing it inside the handler would reach for
  // an element that does not exist yet when the move crosses the window edge.
  useLayoutEffect(() => {
    if (!pendingFocusRef.current) return;
    pendingFocusRef.current = false;
    const target = containerRef.current?.querySelector<HTMLElement>(
      `[data-virtual-index="${focusedIndex}"] [tabindex="0"]`,
    );
    target?.focus();
  }, [focusedIndex, rowWindow]);

  // The focused row stays mounted even when scrolled out of the window: an
  // unmounted focused element drops focus to <body>, which strands keyboard
  // users mid-list. Rendered as its own absolutely-positioned block rather
  // than by widening the window, so scrolling far away still mounts ~30 tiles.
  const focusedRow = Math.floor(focusedIndex / columns);
  const focusedRowIsMounted =
    !measured || items.length === 0 || (focusedRow >= rowWindow.startRow && focusedRow < rowWindow.endRow);

  return (
    /* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions --
       Same delegation as `Tabs`: the tab stop is the focused tile, and the
       list catches the arrows only because they bubble from it. Handling them
       here rather than per tile is what lets the window move the focus to a
       row that is not mounted yet. */
    <div
      aria-label={ariaLabel}
      className={cn("relative w-full shrink-0", className)}
      onFocusCapture={handleFocusCapture}
      onKeyDown={handleKeyDown}
      ref={containerRef}
      role="list"
      style={{ height: totalHeight }}
    >
      <RowBlock
        columns={columns}
        endRow={rowWindow.endRow}
        focusedIndex={focusedIndex}
        gap={gap}
        itemKey={itemKey}
        items={items}
        renderItem={renderItem}
        rowHeight={rowHeight}
        startRow={rowWindow.startRow}
      />
      {focusedRowIsMounted ? null : (
        <RowBlock
          columns={columns}
          endRow={focusedRow + 1}
          focusedIndex={focusedIndex}
          gap={gap}
          itemKey={itemKey}
          items={items}
          renderItem={renderItem}
          rowHeight={rowHeight}
          startRow={focusedRow}
        />
      )}
    </div>
  );
}

type RowBlockProps<T> = {
  columns: number;
  endRow: number;
  focusedIndex: number;
  gap: number;
  itemKey: (item: T, index: number) => string | number;
  items: readonly T[];
  renderItem: (item: T, index: number, opts: { tabIndex: number }) => ReactNode;
  rowHeight: number;
  startRow: number;
};

/** One contiguous run of rows, positioned by its own offset. Two of these ever
 *  exist at a time: the visible window, and the focused row when it has been
 *  scrolled away from. */
function RowBlock<T>({
  columns,
  endRow,
  focusedIndex,
  gap,
  itemKey,
  items,
  renderItem,
  rowHeight,
  startRow,
}: RowBlockProps<T>) {
  if (endRow <= startRow) return null;
  const first = startRow * columns;
  const last = Math.min(items.length, endRow * columns);

  const rendered: ReactNode[] = [];
  for (let index = first; index < last; index++) {
    const item = items[index];
    if (item === undefined) continue;
    rendered.push(
      // `min-w-0` is load-bearing: a grid item defaults to `min-width: auto`,
      // which lets a long unbroken filename push the tile past its column
      // instead of letting the label's `truncate` do its job.
      <div
        aria-posinset={index + 1}
        aria-setsize={items.length}
        className="min-w-0"
        data-virtual-index={index}
        key={itemKey(item, index)}
        role="listitem"
      >
        {renderItem(item, index, { tabIndex: index === focusedIndex ? 0 : -1 })}
      </div>,
    );
  }

  return (
    <div
      className="absolute inset-x-0 grid"
      style={{
        top: startRow * rowHeight,
        gap,
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        // Every row is EXACTLY the height the virtual geometry assumed. Left
        // to `auto`, rows size themselves to their contents, so a block of
        // several rows drifts further from its computed offset with each row
        // — the block's top is positioned, but nothing below it is. That is
        // what made tiles further down a column look misaligned, and it also
        // desynced the spacer height from the real content height.
        gridAutoRows: `${rowHeight - gap}px`,
      }}
    >
      {rendered}
    </div>
  );
}

/** Nearest ancestor that actually scrolls vertically — `PanelBody`, in every
 *  current use. Returns null when there is none, which the grid treats as
 *  "render everything" rather than as an error. */
function findScrollParent(element: HTMLElement): HTMLElement | null {
  let node = element.parentElement;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}
