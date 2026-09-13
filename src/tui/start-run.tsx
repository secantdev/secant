import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  Switch,
  Match,
  type Accessor,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type {
  FieldViolation,
  InstalledBundleFocus,
  InstalledBundleSummary,
  LaunchRunInput,
  Problem,
  RoutingNodeView,
} from "../application/projection-port.js";
import { useBundleCatalogView } from "./bundle-view.js";
import { useBindings } from "./keymap.js";
import { useRunLaunchView, type LaunchOutcome } from "./run-launch-view.js";
import { useExit } from "./vendor/exit.js";
import { useTheme } from "./vendor/theme-context.js";

// The Start-a-Run flow (#90): from Home, one decision per screen — choose an
// Installed Bundle (with a read-only side panel and, for an untrusted digest, an
// inline trust acknowledgement that gates Continue), provide the Bundle-declared
// Launch inputs typed by their Artifact type (skipped when none), review, then
// Start. It drives the *same* `launch-run` Operation the headless client does,
// through the `run-launch-view` seam, and renders each refusal at the step that
// owns the correction while the other draft choices stay intact.
//
// State that survives back-navigation (chosen Bundle index, entered input values,
// the acknowledged digest) lives in this one component, so stepping back never
// loses a draft; only leaving the flow entirely (Escape at the chooser) discards
// it. Exactly one step renders at a time (a Solid <Switch>), so each step's key
// bindings exist only while it is active and cannot conflict.

type Step = "choose" | "inputs" | "review" | "pending";

const NARROW_BREAKPOINT = 60;

export function StartRun(props: {
  onLeave: () => void;
  onStarted: (runId: string) => void;
}) {
  const bundles = useBundleCatalogView();
  const launch = useRunLaunchView();
  const list = bundles.openList();

  const rows = (): readonly InstalledBundleSummary[] => {
    const result = list().result;
    return result.found ? result.bundles : [];
  };
  const listProblem = () => {
    const result = list().result;
    return result.found ? undefined : result.problem;
  };

  const [step, setStep] = createSignal<Step>("choose");
  const [selected, setSelected] = createSignal(0);
  // Every digest the user has acknowledged trust for. A set (not one slot) so an
  // acknowledgement survives moving to another Bundle and back (trust is
  // digest-scoped, ADR 0021).
  const [ackedDigests, setAckedDigests] = createSignal<ReadonlySet<string>>(
    new Set(),
  );
  const [values, setValues] = createStore<Record<string, string>>({});
  const [chooserProblem, setChooserProblem] = createSignal<
    Problem | undefined
  >();
  const [fieldFindings, setFieldFindings] = createSignal<
    readonly FieldViolation[] | undefined
  >();
  const [outcome, setOutcome] = createSignal<
    Accessor<LaunchOutcome> | undefined
  >();

  const active = () => Math.min(selected(), Math.max(0, rows().length - 1));
  const selectedSummary = () => rows()[active()];

  // The focus for the selected Bundle, re-opened when the selection changes: the
  // memo owns each openFocus subscription and disposes the previous one on
  // re-run. The side panel's Workflow line and every Launch input come from here.
  const focusAccessor = createMemo(() => {
    const summary = selectedSummary();
    if (summary === undefined) return undefined;
    return bundles.openFocus({ id: summary.id, version: summary.version });
  });
  const focusBundle = (): InstalledBundleFocus | undefined => {
    const accessor = focusAccessor();
    if (accessor === undefined) return undefined;
    const result = accessor().result;
    return result.found ? result.bundle : undefined;
  };

  // Launch input drafts belong to the chosen Bundle: clear them when the selection
  // moves to a different digest, so a value typed for one Bundle never leaks into
  // another Bundle's same-named input. Drafts still survive back-navigation within
  // one Bundle (its digest does not change), including the refusal round-trip.
  let draftsFor: string | undefined;
  createEffect(() => {
    const digest = focusBundle()?.digest;
    if (digest !== draftsFor) {
      draftsFor = digest;
      setValues(reconcile({}));
    }
  });

  const untrusted = () => focusBundle()?.trust.state === "not-yet-trusted";
  const acknowledged = () => {
    const bundle = focusBundle();
    return bundle !== undefined && ackedDigests().has(bundle.digest);
  };
  // Continue is unavailable until an untrusted digest is acknowledged; a trusted
  // or app-release Bundle needs no acknowledgement (AC1).
  const canContinue = () =>
    focusBundle() !== undefined && (!untrusted() || acknowledged());

  const acknowledge = () => {
    const bundle = focusBundle();
    if (bundle !== undefined && bundle.trust.state === "not-yet-trusted") {
      setAckedDigests((prev) => new Set(prev).add(bundle.digest));
    }
  };

  const continueFromChoose = () => {
    const bundle = focusBundle();
    if (bundle === undefined || !canContinue()) return;
    setChooserProblem(undefined);
    // A Bundle with no declared inputs skips the inputs screen (AC2).
    setStep(bundle.launchInputs.length === 0 ? "review" : "inputs");
  };

  const declaredValues = (): Record<string, string> => {
    const bundle = focusBundle();
    const collected: Record<string, string> = {};
    if (bundle === undefined) return collected;
    // Only names the user actually entered are sent; an omitted required input
    // surfaces as its own field violation from Preflight (AC4).
    for (const input of bundle.launchInputs) {
      const value = values[input.name];
      if (value !== undefined) collected[input.name] = value;
    }
    return collected;
  };

  const startLaunch = () => {
    const bundle = focusBundle();
    if (bundle === undefined) return;
    const input: LaunchRunInput = {
      bundle: { id: bundle.id, version: bundle.version },
      launchInputs: declaredValues(),
      ...(bundle.trust.state === "not-yet-trusted"
        ? { trustDigest: bundle.digest }
        : {}),
    };
    setFieldFindings(undefined);
    setChooserProblem(undefined);
    // Show pending BEFORE submitting: the live seam settles synchronously, so
    // storing the outcome fires the settlement effect at once — a later
    // `setStep("pending")` would clobber the receipt it just set and wedge the
    // screen on "Launching". Pending first lets the effect advance from it.
    setStep("pending");
    setOutcome(() => launch.launch(input));
  };

  // Follow the launch to its settlement: a successful launch transitions
  // straight into that Run's Workbench (#91), replacing #90's receipt; a refusal
  // returns to the step that owns the correction with the finding, leaving every
  // other draft choice intact (AC4). Only `launch-input-invalid` is an
  // inputs-screen fault; every other refusal (Workspace prerequisite, corrupted
  // Bundle, trust, Workspace state) belongs to Bundle selection.
  createEffect(() => {
    const accessor = outcome();
    if (accessor === undefined) return;
    const settled = accessor();
    if (settled.kind === "pending") return;
    if (settled.kind === "launched") {
      props.onStarted(settled.runId);
      return;
    }
    const problem = settled.problem;
    setOutcome(undefined);
    if (problem.code === "launch-input-invalid") {
      setFieldFindings(problem.fieldViolations ?? []);
      setStep("inputs");
    } else {
      setChooserProblem(problem);
      setStep("choose");
    }
  });

  const backFromReview = () => {
    const bundle = focusBundle();
    setStep(
      bundle !== undefined && bundle.launchInputs.length === 0
        ? "choose"
        : "inputs",
    );
  };

  return (
    <Switch>
      <Match when={step() === "choose"}>
        <ChooseStep
          rows={rows}
          listProblem={listProblem}
          selected={active}
          setSelected={setSelected}
          focus={focusBundle}
          untrusted={untrusted}
          acknowledged={acknowledged}
          acknowledge={acknowledge}
          canContinue={canContinue}
          onContinue={continueFromChoose}
          onBack={props.onLeave}
          problem={chooserProblem}
        />
      </Match>
      <Match when={step() === "inputs"}>
        <InputsStep
          bundle={focusBundle}
          values={values}
          setValue={(name, value) => setValues(name, value)}
          findings={fieldFindings}
          onContinue={() => setStep("review")}
          onBack={() => setStep("choose")}
        />
      </Match>
      <Match when={step() === "review"}>
        <ReviewStep
          bundle={focusBundle}
          values={values}
          onStart={startLaunch}
          onBack={backFromReview}
        />
      </Match>
      <Match when={step() === "pending"}>
        <PendingStep />
      </Match>
    </Switch>
  );
}

// --- shared layout ---------------------------------------------------------

function formatRouting(routing: readonly RoutingNodeView[]): string {
  if (routing.length === 0) return "(no steps)";
  return routing
    .map((node) =>
      node.node === "step"
        ? `${node.step.id} (${node.step.kind})`
        : `repeat until ${node.until}`,
    )
    .join(" → ");
}

// --- choose ----------------------------------------------------------------

function ChooseStep(props: {
  rows: Accessor<readonly InstalledBundleSummary[]>;
  listProblem: Accessor<Problem | undefined>;
  selected: Accessor<number>;
  setSelected: (index: number) => void;
  focus: Accessor<InstalledBundleFocus | undefined>;
  untrusted: Accessor<boolean>;
  acknowledged: Accessor<boolean>;
  acknowledge: () => void;
  canContinue: Accessor<boolean>;
  onContinue: () => void;
  onBack: () => void;
  problem: Accessor<Problem | undefined>;
}) {
  const { theme } = useTheme();
  const exit = useExit();
  const dimensions = useTerminalDimensions();
  const stacked = () => dimensions().width < NARROW_BREAKPOINT;

  const move = (delta: number) => {
    const count = props.rows().length;
    if (count === 0) return;
    props.setSelected(
      Math.max(0, Math.min(props.selected() + delta, count - 1)),
    );
  };

  // The acknowledge hint appears only when an untrusted Bundle is selected and
  // still needs it — never on an empty or errored Catalog where `a` does nothing.
  const chooserFooter = () => {
    if (props.canContinue()) {
      return "↑/↓ move · enter continue · esc back · q quit";
    }
    if (props.untrusted() && !props.acknowledged()) {
      return "↑/↓ move · acknowledge trust (a) to continue · esc back · q quit";
    }
    return "↑/↓ move · esc back · q quit";
  };

  useBindings(() => ({
    bindings: [
      {
        key: "up",
        desc: "Previous",
        group: "Start a Run",
        cmd: () => move(-1),
      },
      { key: "down", desc: "Next", group: "Start a Run", cmd: () => move(1) },
      {
        key: "a",
        desc: "Acknowledge trust",
        group: "Start a Run",
        cmd: () => props.acknowledge(),
      },
      {
        key: "return",
        desc: "Continue",
        group: "Start a Run",
        cmd: () => props.onContinue(),
      },
      {
        key: "escape",
        desc: "Back",
        group: "Start a Run",
        cmd: () => props.onBack(),
      },
      { key: "q", desc: "Quit", group: "Start a Run", cmd: () => exit() },
      { key: "ctrl+c", desc: "Quit", group: "Start a Run", cmd: () => exit() },
    ],
  }));

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      padding={1}
      gap={1}
      overflow="hidden"
      backgroundColor={theme.background}
    >
      <text attributes={TextAttributes.BOLD} fg={theme.text} flexShrink={0}>
        Start a Run
      </text>
      <Show when={props.problem()}>
        {(problem) => (
          <box flexDirection="column" flexShrink={0}>
            <text attributes={TextAttributes.BOLD} fg={theme.error}>
              {`Launch refused: ${problem().code}`}
            </text>
            <text fg={theme.textMuted}>{problem().explanation}</text>
            <text fg={theme.textMuted}>{problem().remediation}</text>
          </box>
        )}
      </Show>
      <Show
        when={props.listProblem()}
        fallback={
          <Show
            when={props.rows().length > 0}
            fallback={
              <box flexDirection="column" flexShrink={0}>
                <text fg={theme.textMuted}>The Catalog is empty.</text>
                <text fg={theme.textMuted}>
                  {"Install one with `secant bundle build <folder>` or"}
                </text>
                <text fg={theme.textMuted}>
                  {"`secant bundle install <file.wfb>`."}
                </text>
              </box>
            }
          >
            <box
              flexDirection={stacked() ? "column" : "row"}
              gap={1}
              flexGrow={1}
              overflow="hidden"
            >
              <box
                flexDirection="column"
                flexShrink={0}
                width={stacked() ? undefined : 28}
                overflow="hidden"
              >
                <For each={props.rows()}>
                  {(bundle, index) => (
                    <ChoiceRow
                      bundle={bundle}
                      selected={index() === props.selected()}
                    />
                  )}
                </For>
              </box>
              <box
                flexDirection="column"
                flexShrink={0}
                flexGrow={1}
                overflow="hidden"
              >
                <SidePanel
                  focus={props.focus}
                  untrusted={props.untrusted}
                  acknowledged={props.acknowledged}
                />
              </box>
            </box>
          </Show>
        }
      >
        {(problem) => (
          <box flexDirection="column" flexShrink={0}>
            <text attributes={TextAttributes.BOLD} fg={theme.error}>
              {`Catalog error: ${problem().code}`}
            </text>
            <text fg={theme.textMuted}>{problem().explanation}</text>
            <text fg={theme.textMuted}>{problem().remediation}</text>
          </box>
        )}
      </Show>
      <text
        fg={props.canContinue() ? theme.text : theme.textMuted}
        flexShrink={0}
      >
        {chooserFooter()}
      </text>
    </box>
  );
}

function ChoiceRow(props: {
  bundle: InstalledBundleSummary;
  selected: boolean;
}) {
  const { theme } = useTheme();
  const b = () => props.bundle;
  const color = () => (props.selected ? theme.text : theme.textMuted);
  return (
    <box flexDirection="column" flexShrink={0}>
      <text
        fg={theme.text}
        attributes={props.selected ? TextAttributes.BOLD : 0}
      >
        {`${props.selected ? "› " : "  "}${b().name}`}
      </text>
      <text fg={color()}>{`  ${b().id}@${b().version}`}</text>
    </box>
  );
}

function SidePanel(props: {
  focus: Accessor<InstalledBundleFocus | undefined>;
  untrusted: Accessor<boolean>;
  acknowledged: Accessor<boolean>;
}) {
  const { theme } = useTheme();
  return (
    <Show
      when={props.focus()}
      fallback={<text fg={theme.textMuted}>Select a Bundle.</text>}
    >
      {(bundle) => (
        <box flexDirection="column" flexShrink={0} gap={1} overflow="hidden">
          <box flexDirection="column" flexShrink={0}>
            <text fg={theme.textMuted}>Name</text>
            <text fg={theme.text}>{bundle().name}</text>
          </box>
          <box flexDirection="column" flexShrink={0}>
            <text fg={theme.textMuted}>Description</text>
            <text fg={theme.text}>{bundle().description}</text>
          </box>
          <box flexDirection="column" flexShrink={0}>
            <text fg={theme.textMuted}>Source</text>
            <text fg={theme.text}>
              {`${bundle().origin.kind} ${bundle().origin.location}`}
            </text>
          </box>
          <box flexDirection="column" flexShrink={0}>
            <text fg={theme.textMuted}>Workflow</text>
            <text fg={theme.text}>{formatRouting(bundle().routing)}</text>
          </box>
          {/* ponytail: a calm pointer, not a control — full commands and the
              Execution summary live in Workflow Bundles ▸ inspect, so this panel
              never duplicates them (AC: side panel limited to the four facts). */}
          <text fg={theme.textMuted} flexShrink={0}>
            Full details: Workflow Bundles ▸ inspect.
          </text>
          <Show when={props.untrusted()}>
            <box flexDirection="column" flexShrink={0}>
              <text
                attributes={TextAttributes.BOLD}
                fg={props.acknowledged() ? theme.text : theme.warning}
              >
                {props.acknowledged()
                  ? "Trust acknowledged ✓"
                  : "Untrusted Bundle — press a to acknowledge trust"}
              </text>
              <text fg={theme.textMuted}>
                {`Digest sha256:${bundle().digest}`}
              </text>
              <text fg={theme.textMuted}>
                {bundle().executionSummary.warning}
              </text>
            </box>
          </Show>
        </box>
      )}
    </Show>
  );
}

// --- inputs ----------------------------------------------------------------

function isTextLike(type: string): boolean {
  return type === "text" || type === "file" || type === "file-set";
}

function InputsStep(props: {
  bundle: Accessor<InstalledBundleFocus | undefined>;
  values: Record<string, string>;
  setValue: (name: string, value: string) => void;
  findings: Accessor<readonly FieldViolation[] | undefined>;
  onContinue: () => void;
  onBack: () => void;
}) {
  const { theme } = useTheme();
  const exit = useExit();
  const dimensions = useTerminalDimensions();
  const inputs = () => props.bundle()?.launchInputs ?? [];
  const [field, setField] = createSignal(0);
  const inputWidth = () => Math.max(10, dimensions().width - 4);

  const current = () => inputs()[field()];
  const choiceLike = () => {
    const input = current();
    return (
      input !== undefined &&
      (input.type === "choice" || input.type === "verdict")
    );
  };
  const options = (name: string, type: string): readonly string[] => {
    if (type === "verdict") return ["pass", "fail"];
    const input = inputs().find((candidate) => candidate.name === name);
    return input?.choices ?? [];
  };
  const cycle = (delta: number) => {
    const input = current();
    if (input === undefined) return;
    const choices = options(input.name, input.type);
    if (choices.length === 0) return;
    const index = choices.indexOf(props.values[input.name] ?? "");
    // From an unset value, right lands on the first choice and left on the last;
    // otherwise wrap either way.
    const next =
      index === -1
        ? delta > 0
          ? 0
          : choices.length - 1
        : (index + delta + choices.length) % choices.length;
    props.setValue(input.name, choices[next] ?? "");
  };
  const move = (delta: number) => {
    const count = inputs().length;
    if (count === 0) return;
    setField(Math.max(0, Math.min(field() + delta, count - 1)));
  };
  const findingFor = (name: string): string | undefined =>
    props.findings()?.find((violation) => violation.field === name)
      ?.explanation;

  useBindings(() => ({
    bindings: [
      {
        key: "up",
        desc: "Previous input",
        group: "Launch inputs",
        cmd: () => move(-1),
      },
      {
        key: "down",
        desc: "Next input",
        group: "Launch inputs",
        cmd: () => move(1),
      },
      {
        key: "return",
        desc: "Continue",
        group: "Launch inputs",
        cmd: () => props.onContinue(),
      },
      {
        key: "escape",
        desc: "Back",
        group: "Launch inputs",
        cmd: () => props.onBack(),
      },
      {
        key: "ctrl+c",
        desc: "Quit",
        group: "Launch inputs",
        cmd: () => exit(),
      },
    ],
  }));
  // Only when a choice/verdict input is focused do left/right cycle it; on a
  // text-like input they stay unbound so they reach the focused <input> cursor.
  useBindings(() => ({
    enabled: choiceLike(),
    bindings: [
      {
        key: "left",
        desc: "Previous choice",
        group: "Launch inputs",
        cmd: () => cycle(-1),
      },
      {
        key: "right",
        desc: "Next choice",
        group: "Launch inputs",
        cmd: () => cycle(1),
      },
    ],
  }));

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      padding={1}
      gap={1}
      overflow="hidden"
      backgroundColor={theme.background}
    >
      <text attributes={TextAttributes.BOLD} fg={theme.text} flexShrink={0}>
        Launch inputs
      </text>
      <Show when={props.findings() !== undefined}>
        <text fg={theme.error} flexShrink={0}>
          One or more inputs are missing or invalid.
        </text>
      </Show>
      <box flexDirection="column" gap={1} flexGrow={1} overflow="hidden">
        <For each={inputs()}>
          {(input, index) => (
            <box flexDirection="column" flexShrink={0}>
              <text
                fg={theme.text}
                attributes={index() === field() ? TextAttributes.BOLD : 0}
              >
                {`${index() === field() ? "› " : "  "}${input.name} (${input.type})`}
              </text>
              <text fg={theme.textMuted}>{`  ${input.description}`}</text>
              <Show
                when={isTextLike(input.type)}
                fallback={
                  <text fg={theme.text}>
                    {`  ‹ ${props.values[input.name] ?? "(not set)"} › — ←/→ to choose from: ${options(
                      input.name,
                      input.type,
                    ).join(", ")}`}
                  </text>
                }
              >
                <input
                  focused={index() === field()}
                  width={inputWidth()}
                  value={props.values[input.name] ?? ""}
                  onInput={(value) => props.setValue(input.name, value)}
                />
              </Show>
              <Show when={findingFor(input.name)}>
                {(explanation) => (
                  <text fg={theme.error}>{`  ${explanation()}`}</text>
                )}
              </Show>
            </box>
          )}
        </For>
      </box>
      <text fg={theme.textMuted} flexShrink={0}>
        ↑/↓ input · type to edit · enter continue · esc back
      </text>
    </box>
  );
}

// --- review ----------------------------------------------------------------

function ReviewStep(props: {
  bundle: Accessor<InstalledBundleFocus | undefined>;
  values: Record<string, string>;
  onStart: () => void;
  onBack: () => void;
}) {
  const { theme } = useTheme();
  const exit = useExit();
  const dimensions = useTerminalDimensions();

  useBindings(() => ({
    bindings: [
      {
        key: "return",
        desc: "Start Run",
        group: "Review",
        cmd: () => props.onStart(),
      },
      {
        key: "escape",
        desc: "Back",
        group: "Review",
        cmd: () => props.onBack(),
      },
      { key: "q", desc: "Quit", group: "Review", cmd: () => exit() },
      { key: "ctrl+c", desc: "Quit", group: "Review", cmd: () => exit() },
    ],
  }));

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      padding={1}
      gap={1}
      overflow="hidden"
      backgroundColor={theme.background}
    >
      <text attributes={TextAttributes.BOLD} fg={theme.text} flexShrink={0}>
        Review
      </text>
      <Show
        when={props.bundle()}
        fallback={<text fg={theme.error}>No Bundle selected.</text>}
      >
        {(bundle) => (
          <box flexDirection="column" gap={1} flexGrow={1} overflow="hidden">
            <box flexDirection="column" flexShrink={0}>
              <text fg={theme.text}>{`${bundle().name}`}</text>
              <text
                fg={theme.textMuted}
              >{`${bundle().id}@${bundle().version}`}</text>
              <text
                fg={theme.textMuted}
              >{`digest: sha256:${bundle().digest}`}</text>
            </box>
            <Show
              when={bundle().launchInputs.length > 0}
              fallback={<text fg={theme.textMuted}>No launch inputs.</text>}
            >
              <box flexDirection="column" flexShrink={0}>
                <text fg={theme.textMuted}>Launch inputs</text>
                <For each={bundle().launchInputs}>
                  {(input) => (
                    <text fg={theme.text}>
                      {`  ${input.name}: ${props.values[input.name] ?? "(not set)"}`}
                    </text>
                  )}
                </For>
              </box>
            </Show>
          </box>
        )}
      </Show>
      <text fg={theme.textMuted} flexShrink={0}>
        enter start · esc back · q quit
      </text>
    </box>
  );
}

// --- pending ---------------------------------------------------------------

function PendingStep() {
  const { theme } = useTheme();
  const dimensions = useTerminalDimensions();
  const exit = useExit();
  useBindings(() => ({
    bindings: [
      { key: "q", desc: "Quit", group: "Launching", cmd: () => exit() },
      { key: "ctrl+c", desc: "Quit", group: "Launching", cmd: () => exit() },
    ],
  }));
  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      padding={1}
      overflow="hidden"
      backgroundColor={theme.background}
    >
      <text fg={theme.text} flexShrink={0}>
        Launching… running Preflight.
      </text>
    </box>
  );
}
