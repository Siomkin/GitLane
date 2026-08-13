import { useCallback, useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMultiFileLineComments, type LineCommentsController } from "./comments";
import { StackedFileBreadcrumb } from "./StackedFileBreadcrumb";
import { StackedReviewRow } from "./StackedReviewRow";
import {
  estimatedStackedRowSize,
  stackedFileAtViewportTop,
  type StackedReviewModel,
} from "./stackedReviewRows";

const STACKED_OVERSCAN = 24;

export function StackedReviewList({
  model,
  surface,
  selectedPath,
  fileSelectionRequestId,
  onToggle,
  onShowFull,
  onVisibleFiles,
}: {
  model: StackedReviewModel;
  surface: string;
  selectedPath: string | null;
  fileSelectionRequestId: number;
  onToggle: (path: string) => void;
  onShowFull: (path: string) => void;
  onVisibleFiles: (
    paths: string[],
    measureFileBody: (path: string) => number | null,
  ) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastNavigation = useRef<{ path: string; requestId: number } | null>(null);
  const comments = useMultiFileLineComments(surface, model.linesByFile);
  const virtualizer = useVirtualizer({
    count: model.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => estimatedStackedRowSize(model.rows[index]),
    getItemKey: (index) => model.rows[index].key,
    overscan: STACKED_OVERSCAN,
    // File selection can issue scrollToIndex from an effect. Let React batch
    // the resulting range update instead of forcing a nested synchronous flush.
    useFlushSync: false,
  });
  const items = virtualizer.getVirtualItems();
  const activeFile = stackedFileAtViewportTop(
    model,
    items,
    scrollRef.current?.scrollTop ?? 0,
  );

  // The measured height of a file's body rows (falling back to TanStack's
  // estimates for rows that never mounted). Snapshotted by the eviction path so
  // a placeholder preserves the real scroll height — including comment cards
  // and binary previews the static estimate can't know about. Kept behind a
  // stable identity so it doesn't churn the visible-files effect.
  const measureBodyRef = useRef<(path: string) => number | null>(() => null);
  measureBodyRef.current = (path) => {
    const range = model.bodyRangeByPath.get(path);
    if (!range || range.end <= range.start) return null;
    let total = 0;
    for (let index = range.start; index < range.end; index += 1) {
      total += virtualizer.measurementsCache[index]?.size ?? 0;
    }
    return total;
  };
  const measureFileBody = useCallback(
    (path: string) => measureBodyRef.current(path),
    [],
  );

  // Only paths in the viewport/overscan window are eligible to fetch. Encoding
  // the set makes the effect stable even though TanStack returns a fresh items
  // array while measuring dynamic rows.
  const visibleFilesJson = JSON.stringify([
    ...new Set(
      items.flatMap((item) => {
        const row = model.rows[item.index];
        return row && "file" in row ? [row.file.path] : [];
      }),
    ),
  ]);
  useEffect(() => {
    onVisibleFiles(JSON.parse(visibleFilesJson) as string[], measureFileBody);
  }, [measureFileBody, onVisibleFiles, visibleFilesJson]);

  // Right-panel file selection used to depend on mounted section refs. Every
  // file header now has a stable row index, so navigation works even when the
  // target is far outside the mounted virtual window.
  useEffect(() => {
    if (!selectedPath) {
      lastNavigation.current = null;
      return;
    }
    if (
      lastNavigation.current?.path === selectedPath &&
      lastNavigation.current.requestId === fileSelectionRequestId
    ) {
      return;
    }
    const index = model.headerIndexByPath.get(selectedPath);
    if (index == null) return;
    // TanStack may synchronously flush its measurement update. Schedule the
    // command outside React's lifecycle so selecting a file cannot trigger a
    // nested flush while this component is still committing.
    const timer = window.setTimeout(() => {
      lastNavigation.current = { path: selectedPath, requestId: fileSelectionRequestId };
      virtualizer.scrollToIndex(index, { align: "start", behavior: "auto" });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fileSelectionRequestId, model.headerIndexByPath, selectedPath, virtualizer]);

  const controllers = new Map<string, LineCommentsController>();
  const controllerFor = (file: string) => {
    const existing = controllers.get(file);
    if (existing) return existing;
    const controller = comments.controllerFor(file);
    controllers.set(file, controller);
    return controller;
  };

  return (
    <div
      ref={scrollRef}
      data-testid="stacked-review-scroll"
      className="min-h-0 flex-1 overflow-auto bg-white dark:bg-neutral-800"
    >
      <div className="pointer-events-none sticky top-0 z-20 h-0">
        {activeFile && (
          <StackedFileBreadcrumb
            file={activeFile}
            onCollapse={() => {
              // Parity with the old always-sticky header: collapse from
              // anywhere inside a long file, landing back on its header row
              // (whose index is unaffected by collapsing the rows after it).
              onToggle(activeFile.path);
              const index = model.headerIndexByPath.get(activeFile.path);
              if (index != null) virtualizer.scrollToIndex(index, { align: "start" });
            }}
          />
        )}
      </div>
      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: "relative",
          width: "100%",
        }}
      >
        {items.map((item) => {
          const row = model.rows[item.index];
          return (
            <div
              key={item.key}
              data-index={item.index}
              data-row-kind={row.kind}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${item.start}px)`,
              }}
            >
              <StackedReviewRow
                row={row}
                selectedPath={selectedPath}
                controllerFor={controllerFor}
                onToggle={onToggle}
                onShowFull={onShowFull}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
