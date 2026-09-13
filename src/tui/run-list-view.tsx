import {
  createContext,
  createSignal,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js";
import type {
  ProjectionPort,
  RunListFilter,
  RunListRow,
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
// ponytail: no durable-updates follow for M2 — the list re-reads on open, filter
// toggle, and each page load; a live list that grows as new Runs launch is a later
// slice, not M2. Add an updates loop here if the list must refresh in place.

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
      let cursor: string | undefined;
      let rows: readonly RunListRow[] = [];
      const [state, setState] = createSignal<RunListState>({
        rows: [],
        filter: "all",
        beginningOfHistory: true,
        hasMore: false,
      });

      const read = (before?: string) => {
        const opened = port.openProjection({
          family: "run-list",
          ...(resumable ? { resumable: true } : {}),
          ...(before !== undefined ? { before } : {}),
        });
        const snapshot = opened.snapshot;
        opened.close();
        return snapshot;
      };

      const publish = (
        filter: RunListFilter,
        beginningOfHistory: boolean,
      ): void => {
        setState({
          rows,
          filter,
          beginningOfHistory,
          hasMore: cursor !== undefined,
        });
      };

      const refresh = (): void => {
        const snapshot = read();
        rows = [...snapshot.rows];
        cursor = snapshot.nextCursor;
        publish(snapshot.filter, snapshot.beginningOfHistory);
      };

      refresh();

      return {
        state,
        setResumable(next) {
          if (next === resumable) return;
          resumable = next;
          refresh();
        },
        loadMore() {
          if (cursor === undefined) return;
          const snapshot = read(cursor);
          rows = [...rows, ...snapshot.rows];
          cursor = snapshot.nextCursor;
          publish(snapshot.filter, snapshot.beginningOfHistory);
        },
      };
    },
  };
}
