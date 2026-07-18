import { useCallback, useMemo, useRef } from "react";
import { observeElementRect, useVirtualizer } from "@tanstack/react-virtual";
import type { FileDiff } from "@/lib/api/git";
import { StatusPill } from "@/components/ui/StatusBadge";
import { ChangeCounts } from "@/components/ui/ChangeCounts";
import { BinaryDiff } from "@/features/review/BinaryDiff";
import {
  DiffTruncatedNotice,
  HunkCardHeader,
  UnifiedLine,
} from "@/features/review/DiffBody";
import {
  useMultiFileLineComments,
  type LineCommentsController,
} from "@/features/review/comments";
import {
  buildPrDiffModel,
  estimatedPrDiffRowSize,
  type PrDiffRow,
} from "./prDiffRows";

const PR_DIFF_OVERSCAN = 24;

export function PrDiffList({
  diffs,
  surface,
}: {
  diffs: FileDiff[];
  surface: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const model = useMemo(() => buildPrDiffModel(diffs), [diffs]);
  const noteFileForKey = useCallback(
    (key: string) => model.noteFileByKey.get(key) ?? key,
    [model.noteFileByKey],
  );
  const comments = useMultiFileLineComments(surface, model.linesByFile, {
    noteFileForKey,
  });
  const virtualizer = useVirtualizer({
    count: model.rows.length,
    getScrollElement: () => scrollRef.current,
    // Paint an initial viewport before ResizeObserver reports the real panel
    // dimensions. This also keeps headless tests representative instead of
    // producing an empty first window for a zero-sized DOM shim.
    initialRect: { width: 1_000, height: 800 },
    observeElementRect: (instance, callback) =>
      observeElementRect(instance, (rect) =>
        callback({ width: rect.width, height: rect.height || 800 }),
      ),
    estimateSize: (index) => estimatedPrDiffRowSize(model.rows[index]),
    measureElement: (element) => {
      const measured = element.getBoundingClientRect().height;
      if (measured > 0) return measured;
      const index = Number(element.getAttribute("data-index"));
      return estimatedPrDiffRowSize(model.rows[index]);
    },
    getItemKey: (index) => model.rows[index].key,
    overscan: PR_DIFF_OVERSCAN,
    useFlushSync: false,
  });
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
      data-testid="pr-diff-scroll"
      className="min-h-0 flex-1 overflow-auto"
    >
      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: "relative",
          width: "100%",
        }}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const row = model.rows[item.index];
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${item.start}px)`,
              }}
            >
              <PrDiffVirtualRow row={row} controllerFor={controllerFor} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PrDiffVirtualRow({
  row,
  controllerFor,
}: {
  row: PrDiffRow;
  controllerFor: (file: string) => LineCommentsController;
}) {
  switch (row.kind) {
    case "commit":
      return (
        <div
          data-testid="commit-group-header"
          className="flex min-w-0 items-center gap-2 px-1 pb-2 pt-1"
        >
          <span className="shrink-0 rounded bg-black/5 px-1.5 py-0.5 font-mono text-[11px] text-neutral-500 dark:bg-white/10 dark:text-neutral-400">
            {row.oid.slice(0, 7)}
          </span>
          <span className="min-w-0 truncate text-[12px] font-medium text-neutral-600 dark:text-neutral-300">
            {row.subject ?? ""}
          </span>
        </div>
      );
    case "file-header": {
      const name = row.file.path.split("/").pop() ?? row.file.path;
      const dir = row.file.path.split("/").slice(0, -1).join("/");
      return (
        <div className="flex items-center gap-2.5 rounded-t-xl border-x border-t border-black/5 bg-white px-3.5 py-2.5 shadow-sm dark:border-white/5 dark:bg-neutral-800">
          <StatusPill status={row.file.status} />
          <div className="min-w-0 flex-1 truncate text-[12.5px]">
            <span className="text-neutral-400">{dir ? `${dir}/` : ""}</span>
            <span className="font-medium text-neutral-800 dark:text-neutral-100">
              {name}
            </span>
          </div>
          <ChangeCounts
            add={row.file.add}
            del={row.file.del}
            binary={row.file.binary}
            className="shrink-0 text-[11px]"
          />
        </div>
      );
    }
    case "hunk":
      return (
        <div className="border-x border-black/5 bg-white dark:border-white/5 dark:bg-neutral-800">
          <HunkCardHeader header={row.row.header} changed={row.row.changed} />
        </div>
      );
    case "line": {
      const controller = controllerFor(row.commentKey);
      return (
        <div className="border-x border-black/5 bg-white dark:border-white/5 dark:bg-neutral-800">
          <UnifiedLine
            line={row.row.line}
            comments={controller.rowFor(row.row.seq)}
            controller={controller}
          />
        </div>
      );
    }
    case "binary":
      return (
        <div className="border-x border-black/5 bg-white dark:border-white/5 dark:bg-neutral-800">
          <BinaryDiff diff={row.file} />
        </div>
      );
    case "truncated":
      return (
        <div className="border-x border-black/5 bg-white dark:border-white/5 dark:bg-neutral-800">
          <DiffTruncatedNotice message="Large PR diff capped for performance — remaining lines are not shown." />
        </div>
      );
    case "file-end":
      return (
        <div className="mb-4 h-px rounded-b-xl border-x border-b border-black/5 bg-white shadow-sm dark:border-white/5 dark:bg-neutral-800" />
      );
  }
}
