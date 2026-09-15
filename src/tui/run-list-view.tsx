import {
  createContext,
  createSignal,
  onCleanup,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js";
import type {
  OpenedProjection,
  ProjectionPort,
  RunListFilter,
  RunListRow,
  RunListSnapshot,
} from "../application/projection-port.js";

// The read seam the Previous Runs list reads through (#92), mirroring the shape of
// run-view.tsx but adding cursor paging: it opens the `run-list` Projection under
// the current filter, and pages older rows by re-opening with the returned
// `before` cursor and *appending* them. Because rows are newest-first, an older
// page appends at the end of the accumulated array — nothing above shifts — so the
// first visible row and the viewport stay fixed as older rows load (the
// append-stable "prepend anchor" the timeline model uses, see run-timeline.ts).
//
// Read-only: Run state and Actions live only on the exact `run` Projection, so
// selecting a row opens its Workbench (which carries the run-actions submit seam).
// Every loaded page remains open and follows durable updates. That lets a live
// marker clear in place when its Run rests without shifting an older loaded page.

/** The accumulated Previous Runs the screen renders: every row loaded so far under
 *  the current filter, whether an older page remains, and whether the last loaded
 *  page reached the beginning of history. */
export interface RunListState {
  readonly rows: readonly RunListRow[];
  readonly filter: RunListFilter;
  readonly beginningOfHistory: boolean;
  readonly hasMore: boolean;
}

export interface RunListController {
  readonly state: Accessor<RunListState>;
  /** Switch the filter (All ⇄ Resumable) and reload from the newest page. */
  setResumable(resumable: boolean): void;
  /** Load the next older page by cursor and append it; a no-op past the end. */
  loadMore(): void;
}

export interface RunListView {
  /** Open the Workspace's Previous Runs; returns the accumulated state plus its
   *  filter and paging controls. Call inside a reactive owner. */
  openRunList(): RunListController;
}

const ctx = createContext<RunListView>();

export function RunListViewProvider(props: ParentProps<{ view: RunListView }>) {
  return <ctx.Provider value={props.view}>{props.children}</ctx.Provider>;
}

export function useRunListView(): RunListView {
  const value = useContext(ctx);
  if (!value)
    throw new Error("useRunListView must be used within a RunListViewProvider");
  return value;
}

/** A live Previous Runs seam over the Projection Port. */
export function createLiveRunListView(port: ProjectionPort): RunListView {
  return {
    openRunList() {
      let resumable = false;
      let generation = 0;
      const pages: {
        readonly before?: string;
        opened: OpenedProjection<RunListSnapshot>;
        snapshot: RunListSnapshot;
      }[] = [];
      const [state, setState] = createSignal<RunListState>({
        rows: [],
        filter: "all",
        beginningOfHistory: true,
        hasMore: false,
      });

      const openPage = (before?: string): void => {
        const opened = port.openProjection({
          family: "run-list",
          ...(resumable ? { resumable: true } : {}),
          ...(before !== undefined ? { before } : {}),
        });
        const page = { before, opened, snapshot: opened.snapshot };
        pages.push(page);
        publish();
        const openedGeneration = generation;
        void (async () => {
          for await (const update of opened.updates) {
            if (openedGeneration !== generation) break;
            if (update.kind === "durable") {
              page.snapshot = update.snapshot;
              publish();
            }
          }
        })();
      };

      const publish = (): void => {
        const seen = new Set<string>();
        const rows: RunListRow[] = [];
        for (const page of pages) {
          for (const row of page.snapshot.rows) {
            if (seen.has(row.runId)) continue;
            seen.add(row.runId);
            rows.push(row);
          }
        }
        const first = pages[0]?.snapshot;
        const last = pages[pages.length - 1]?.snapshot;
        setState({
          rows,
          filter: first?.filter ?? (resumable ? "resumable" : "all"),
          beginningOfHistory: last?.beginningOfHistory ?? true,
          hasMore: last?.nextCursor !== undefined,
        });
      };

      const refresh = (): void => {
        generation += 1;
        for (const page of pages) page.opened.close();
        pages.length = 0;
        openPage();
      };

      refresh();
      onCleanup(() => {
        generation += 1;
        for (const page of pages) page.opened.close();
      });

      return {
        state,
        setResumable(next) {
          if (next === resumable) return;
          resumable = next;
          refresh();
        },
        loadMore() {
          const cursor = pages[pages.length - 1]?.snapshot.nextCursor;
          if (cursor !== undefined) openPage(cursor);
        },
      };
    },
  };
}
