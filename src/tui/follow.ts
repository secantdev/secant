import { createSignal, onCleanup, type Accessor } from "solid-js";
import type {
  CatchUp,
  ObserverEnd,
  OpenedProjection,
  ProjectionSnapshot,
  ProjectionUpdate,
} from "../application/projection-port.js";

// The one follow helper the per-screen view seams share (A22): seed from an
// atomic Projection barrier, follow updates, expose observer health, reopen on
// explicit reconnect, and close on cleanup. Iteration and recovery live here so
// screens never duplicate stream lifecycle logic.

/**
 * Health stays distinct from snapshot content: closing preserves last-known
 * state but marks it disconnected, and reopening crosses loading and catching-up
 * before the new barrier becomes current. Call inside a reactive owner because
 * cleanup owns the active Projection and suppresses late updates.
 */
export type TProjectionStreamHealth =
  | {
      readonly kind: "current";
      readonly catchUp: CatchUp;
      readonly lastConfirmedAt: string;
    }
  | { readonly kind: "loading"; readonly lastConfirmedAt: string }
  | {
      readonly kind: "catching-up";
      readonly catchUp: CatchUp;
      readonly lastConfirmedAt: string;
    }
  | {
      readonly kind: "disconnected";
      readonly reason: ObserverEnd;
      readonly lastConfirmedAt: string;
    };

export interface FollowedProjection<State> {
  readonly state: Accessor<State>;
  readonly freshness: Accessor<TProjectionStreamHealth>;
  reconnect(): void;
}

type TFollowProjectionOptions<S extends ProjectionSnapshot, State> = {
  readonly open: () => OpenedProjection<S>;
  readonly seed: (snapshot: S) => State;
  readonly reduce: (state: State, update: ProjectionUpdate<S>) => State;
};

/** Follow one Projection while a caller-owned reducer decides how each update
 * lane changes state. The opener remains here so reconnect can replace the
 * observer without leaking lifecycle work back into a screen. */
export function followProjectionUpdates<S extends ProjectionSnapshot, State>(
  options: TFollowProjectionOptions<S, State>,
): FollowedProjection<State> {
  let opened = options.open();
  let lastConfirmedAt = new Date().toISOString();
  const [state, setState] = createSignal<State>(options.seed(opened.snapshot));
  const [freshness, setFreshness] = createSignal<TProjectionStreamHealth>({
    kind: "current",
    catchUp: opened.catchUp,
    lastConfirmedAt,
  });
  let disposed = false;
  let generation = 0;

  const follow = (current: OpenedProjection<S>, currentGeneration: number) => {
    void (async () => {
      for await (const update of current.updates) {
        if (disposed || currentGeneration !== generation) break;
        if (update.kind === "closed") {
          current.close();
          setState((value) => options.reduce(value, update));
          setFreshness({
            kind: "disconnected",
            reason: update.reason,
            lastConfirmedAt,
          });
          return;
        }
        lastConfirmedAt = new Date().toISOString();
        setState((value) => options.reduce(value, update));
        setFreshness({
          kind: "current",
          catchUp: current.catchUp,
          lastConfirmedAt,
        });
      }
    })();
  };

  follow(opened, generation);

  const reconnect = () => {
    if (disposed || freshness().kind !== "disconnected") return;
    generation += 1;
    const reconnectGeneration = generation;
    setFreshness({ kind: "loading", lastConfirmedAt });
    queueMicrotask(() => {
      if (disposed || reconnectGeneration !== generation) return;
      opened = options.open();
      lastConfirmedAt = new Date().toISOString();
      setState((value) =>
        options.reduce(value, {
          kind: "durable",
          snapshot: opened.snapshot,
        }),
      );
      setFreshness({
        kind: "catching-up",
        catchUp: opened.catchUp,
        lastConfirmedAt,
      });
      follow(opened, reconnectGeneration);
      // `openProjection` returns only after its atomic durable catch-up barrier.
      // Publish catching-up while Solid incorporates that barrier snapshot, then
      // mark it current; waiting for a future update would strand a quiet Run.
      queueMicrotask(() => {
        if (
          disposed ||
          reconnectGeneration !== generation ||
          freshness().kind !== "catching-up"
        ) {
          return;
        }
        setFreshness({
          kind: "current",
          catchUp: opened.catchUp,
          lastConfirmedAt,
        });
      });
    });
  };

  onCleanup(() => {
    disposed = true;
    generation += 1;
    opened.close();
  });
  return { state, freshness, reconnect };
}

export function followProjection<S extends ProjectionSnapshot>(
  open: () => OpenedProjection<S>,
): Accessor<S> {
  return followProjectionUpdates<S, S>({
    open,
    seed: (snapshot) => snapshot,
    reduce: (snapshot, update) =>
      update.kind === "durable" ? update.snapshot : snapshot,
  }).state;
}
