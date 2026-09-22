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
  HarnessFocus,
  HarnessSummary,
  InstalledBundleFocus,
  InstalledBundleSummary,
  LaunchRunInput,
  Problem,
  RoutingNodeView,
} from "../application/projection-port.js";
import { BundleCatalog } from "./bundle-catalog.js";
import { useBundleCatalogView } from "./bundle-view.js";
import {
  discoveryWord,
  harnessRowStatus,
  qualificationWord,
} from "./harness-format.js";
import { useHarnessCatalogView } from "./harness-view.js";
import { useBindings } from "./keymap.js";
import { useRunLaunchView, type LaunchOutcome } from "./run-launch-view.js";
import { useExit } from "./vendor/exit.js";
import { useDialog } from "./vendor/dialog.js";
import { useTheme } from "./vendor/theme-context.js";

// The Start-a-Run flow (#90, #191): from Home — where it is now the first and
// default entry — one decision per screen. Choose an Installed Bundle (with a
// read-only side panel, a `View Bundle Details` jump into the Bundle catalog, and
// an inline trust acknowledgement that gates Continue), choose a Harness and model
// for an Agent-bearing Bundle, provide the Bundle-declared Launch inputs (skipped
// when none), review, then Start. The steps are numbered `N of M` with Harness
// omitted for a Command-only Bundle and Inputs omitted when the Bundle declares
// none. It drives the *same* `launch-run` Operation the headless client does,
// through the `run-launch-view` seam, and renders each refusal at the step that
// owns the correction while the other draft choices stay intact.
//
// The Harness step reads the spawn-free `harness-catalog` list for its rows and
// worded qualification/availability; choosing a Harness opens that one's focus,
// which qualifies only it and carries the supported-model declaration the model
// field renders (a choice list, free-text entry, or `Harness default` alone).
//
// State that survives back-navigation (chosen Bundle index, chosen Harness, the
// requested model, entered input values, the acknowledged digest) lives in this one
// component, so stepping back never loses a draft; only leaving the flow entirely
// (Escape at the chooser) discards it. Exactly one step renders at a time (a Solid
// <Switch>), so each step's key bindings exist only while it is active.

type Step = "choose" | "harness" | "inputs" | "review" | "pending";

const NARROW_BREAKPOINT = 60;

// `Harness default` means no requested model: the Harness's own configuration
// decides. It is the first option in both the list and free-text model fields.
const HARNESS_DEFAULT = "Harness default";

export function StartRun(props: {
  onLeave: () => void;
  onStarted: (runId: string, bundleName: string) => void;
}) {
  const bundles = useBundleCatalogView();
  const harnessCatalog = useHarnessCatalogView();
  const launch = useRunLaunchView();
  const list = bundles.openList();
  // The Harness list is opened once for the whole flow: a list open is discovery
  // only and spawns nothing (#191). Only choosing a Harness opens its focus.
  const harnessList = harnessCatalog.openList();

  const rows = (): readonly InstalledBundleSummary[] => {
    const result = list().result;
    return result.found ? result.bundles : [];
  };
  const listProblem = () => {
    const result = list().result;
    return result.found ? undefined : result.problem;
  };

  const [step, setStep] = createSignal<Step>("choose");
  const [catalogOpen, setCatalogOpen] = createSignal(false);
  const [selected, setSelected] = createSignal(0);
  // The chosen Harness id (undefined until the user chooses one) and the requested
  // model draft (undefined means `Harness default`). Both survive back-navigation.
  const [chosenHarnessId, setChosenHarnessId] = createSignal<
    string | undefined
  >();
  const [requestedModel, setRequestedModel] = createSignal<
    string | undefined
  >();
  // Every digest the user has acknowledged trust for. A set (not one slot) so an
  // acknowledgement survives moving to another Bundle and back (trust is
  // digest-scoped, ADR 0021).
  const [ackedDigests, setAckedDigests] = createSignal<ReadonlySet<string>>(
    new Set(),
  );
  const [values, setValues] = createStore<Record<string, string>>({});
  let submittedBundleName: string | undefined;
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

  const harnessRows = (): readonly HarnessSummary[] => harnessList().harnesses;
  const chosenHarnessSummary = (): HarnessSummary | undefined =>
    harnessRows().find((harness) => harness.id === chosenHarnessId());
  // The focus for the chosen Harness, re-opened when the choice changes: the memo
  // owns each openFocus subscription and disposes the previous on re-run. Opening a
  // focus qualifies exactly that Harness; nothing is opened until one is chosen.
  const harnessFocusAccessor = createMemo(() => {
    const id = chosenHarnessId();
    if (id === undefined) return undefined;
    return harnessCatalog.openFocus({ id });
  });
  const chosenHarnessFocus = (): HarnessFocus | undefined => {
    const accessor = harnessFocusAccessor();
    if (accessor === undefined) return undefined;
    const result = accessor().result;
    return result.found ? result.harness : undefined;
  };

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
    setStep(
      routingNeedsHarness(bundle.routing) ? "harness" : nextDraftStep(bundle),
    );
  };

  // The user has chosen a Harness (opening its focus qualifies only that one). A
  // different choice resets the model draft, since the previous model may not be
  // one the new Harness supports; the launch revalidates regardless.
  const chooseHarness = (id: string) => {
    if (chosenHarnessId() !== id) setRequestedModel(undefined);
    setChosenHarnessId(id);
  };

  const continueFromHarness = () => {
    const bundle = focusBundle();
    const focus = chosenHarnessFocus();
    if (bundle === undefined || focus === undefined || focus.unavailable) {
      return;
    }
    setChooserProblem(undefined);
    setStep(nextDraftStep(bundle));
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
    const needsHarness = routingNeedsHarness(bundle.routing);
    const input: LaunchRunInput = {
      bundle: { id: bundle.id, version: bundle.version },
      launchInputs: declaredValues(),
      harness: needsHarness ? chosenHarnessId() : undefined,
      // The draft carries the requested model into the launch; a Command-only
      // Bundle asks for neither Harness nor model (#191). `Harness default` is the
      // absence of a requested model, so it rides as `undefined`.
      requestedModel: needsHarness ? requestedModel() : undefined,
      trustDigest:
        bundle.trust.state === "not-yet-trusted" ? bundle.digest : undefined,
    };
    setFieldFindings(undefined);
    setChooserProblem(undefined);
    submittedBundleName = bundle.name;
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
  // other draft choice intact (AC4). The Port itself says which surface owns the
  // correction (#98 A15): a Problem carrying field violations is an inputs-screen
  // fault, so the screen reads that presence rather than re-matching a Problem code
  // string; every other refusal (Workspace prerequisite, corrupted Bundle, trust,
  // Workspace state) belongs to Bundle selection.
  createEffect(() => {
    const accessor = outcome();
    if (accessor === undefined) return;
    const settled = accessor();
    if (settled.kind === "pending") return;
    if (settled.kind === "launched") {
      if (submittedBundleName === undefined) {
        throw new Error("a launched Run must retain its submitted Bundle name");
      }
      props.onStarted(settled.runId, submittedBundleName);
      return;
    }
    const problem = settled.problem;
    setOutcome(undefined);
    if (problem.fieldViolations !== undefined) {
      setFieldFindings(problem.fieldViolations);
      setStep("inputs");
    } else if (problem.correction === "harness-selection") {
      setChooserProblem(problem);
      setStep("harness");
    } else {
      setChooserProblem(problem);
      setStep("choose");
    }
  });

  const backFromReview = () => {
    const bundle = focusBundle();
    setStep(
      bundle !== undefined && bundle.launchInputs.length === 0
        ? routingNeedsHarness(bundle.routing)
          ? "harness"
          : "choose"
        : "inputs",
    );
  };

  // The ordered steps present for a Bundle, so each step can render its `N of M`
  // position: Harness only when the routing needs one, Inputs only when the Bundle
  // declares launch inputs (#191). `pending` is not a numbered step.
  const stepSequence = (bundle: InstalledBundleFocus): Step[] => {
    const sequence: Step[] = ["choose"];
    if (routingNeedsHarness(bundle.routing)) sequence.push("harness");
    if (bundle.launchInputs.length > 0) sequence.push("inputs");
    sequence.push("review");
    return sequence;
  };
  const stepLabel = (which: Step): string => {
    const bundle = focusBundle();
    if (bundle === undefined) return "";
    const sequence = stepSequence(bundle);
    const position = sequence.indexOf(which);
    if (position === -1) return "";
    return `Step ${position + 1} of ${sequence.length}`;
  };

  return (
    <Show
      when={catalogOpen()}
      fallback={
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
              stepLabel={() => stepLabel("choose")}
              onContinue={continueFromChoose}
              onViewDetails={() => setCatalogOpen(true)}
              onBack={props.onLeave}
              problem={chooserProblem}
            />
          </Match>
          <Match when={step() === "harness"}>
            <HarnessStep
              rows={harnessRows}
              chosenId={chosenHarnessId}
              choose={chooseHarness}
              focus={chosenHarnessFocus}
              model={requestedModel}
              setModel={setRequestedModel}
              stepLabel={() => stepLabel("harness")}
              problem={chooserProblem}
              onContinue={continueFromHarness}
              onBack={() => setStep("choose")}
            />
          </Match>
          <Match when={step() === "inputs"}>
            <InputsStep
              bundle={focusBundle}
              values={values}
              setValue={(name, value) => setValues(name, value)}
              findings={fieldFindings}
              stepLabel={() => stepLabel("inputs")}
              onContinue={() => setStep("review")}
              onBack={() =>
                setStep(focusNeedsHarness(focusBundle()) ? "harness" : "choose")
              }
            />
          </Match>
          <Match when={step() === "review"}>
            <ReviewStep
              bundle={focusBundle}
              harness={chosenHarnessSummary}
              model={requestedModel}
              values={values}
              stepLabel={() => stepLabel("review")}
              onStart={startLaunch}
              onBack={backFromReview}
            />
          </Match>
          <Match when={step() === "pending"}>
            <PendingStep />
          </Match>
        </Switch>
      }
    >
      <BundleCatalog
        selected={active}
        setSelected={setSelected}
        onBack={() => setCatalogOpen(false)}
      />
    </Show>
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

function routingNeedsHarness(routing: readonly RoutingNodeView[]): boolean {
  return routing.some((node) => {
    const steps = node.node === "step" ? [node.step] : node.steps;
    return steps.some((step) => {
      return step.kind === "agent" || step.kind === "interactive-agent";
    });
  });
}

function nextDraftStep(bundle: InstalledBundleFocus): Step {
  return bundle.launchInputs.length === 0 ? "review" : "inputs";
}

function focusNeedsHarness(bundle: InstalledBundleFocus | undefined): boolean {
  return bundle !== undefined && routingNeedsHarness(bundle.routing);
}

// A muted `Step N of M` line under a step title (blank while no Bundle is
// selected — the empty/errored Catalog has no sequence to count).
function StepCount(props: { label: Accessor<string> }) {
  const { theme } = useTheme();
  return (
    <Show when={props.label().length > 0}>
      <text fg={theme.textMuted} flexShrink={0}>
        {props.label()}
      </text>
    </Show>
  );
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
  stepLabel: Accessor<string>;
  onContinue: () => void;
  onViewDetails: () => void;
  onBack: () => void;
  problem: Accessor<Problem | undefined>;
}) {
  const { theme } = useTheme();
  const exit = useExit();
  const dialog = useDialog();
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
      return "↑/↓ move · v view details · enter continue · esc back · q quit";
    }
    if (props.untrusted() && !props.acknowledged()) {
      return "↑/↓ move · v view details · acknowledge trust (a) to continue · esc back · q quit";
    }
    return "↑/↓ move · v view details · esc back · q quit";
  };

  useBindings(() => ({
    enabled: dialog.stack.length === 0,
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
        key: "v",
        desc: "View Bundle Details",
        group: "Start a Run",
        cmd: () => props.onViewDetails(),
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
      <StepCount label={props.stepLabel} />
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
          {/* A calm navigation pointer — full commands and the Execution summary
              live in Workflow Bundles, so this panel never duplicates them. */}
          <text fg={theme.textMuted} flexShrink={0}>
            Press v to View Bundle Details.
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

// --- Harness selection + model --------------------------------------------

type HarnessPhase = "list" | "model";

function HarnessStep(props: {
  rows: Accessor<readonly HarnessSummary[]>;
  chosenId: Accessor<string | undefined>;
  choose: (id: string) => void;
  focus: Accessor<HarnessFocus | undefined>;
  model: Accessor<string | undefined>;
  setModel: (model: string | undefined) => void;
  stepLabel: Accessor<string>;
  problem: Accessor<Problem | undefined>;
  onContinue: () => void;
  onBack: () => void;
}) {
  const { theme } = useTheme();
  const exit = useExit();
  const dialog = useDialog();
  const dimensions = useTerminalDimensions();

  // Start on the model field when a Harness is already chosen (a return visit,
  // e.g. after a refusal), otherwise on the list. Choosing spawns nothing until it
  // happens: the initial open with nothing chosen never opens a focus.
  const chosenIndex = () =>
    Math.max(
      0,
      props.rows().findIndex((harness) => harness.id === props.chosenId()),
    );
  const [highlight, setHighlight] = createSignal(
    props.chosenId() === undefined ? 0 : chosenIndex(),
  );
  const [phase, setPhase] = createSignal<HarnessPhase>(
    props.chosenId() === undefined ? "list" : "model",
  );

  const move = (delta: number) => {
    const count = props.rows().length;
    if (count === 0) return;
    setHighlight(Math.max(0, Math.min(highlight() + delta, count - 1)));
  };

  const chooseHighlighted = () => {
    const harness = props.rows()[highlight()];
    if (harness === undefined) return;
    props.choose(harness.id);
    setPhase("model");
  };

  const declaration = () => props.focus()?.supportedModels;
  // A qualified Harness declares a model list, free-text entry, or (when it exposes
  // no model selection) neither — then only `Harness default` is offered, with no
  // field to change and no requested model.
  const modelMode = (): "list" | "free-text" | "default-only" => {
    const decl = declaration();
    return decl?.kind === "list"
      ? "list"
      : decl?.kind === "free-text"
        ? "free-text"
        : "default-only";
  };
  const available = () =>
    props.focus() !== undefined && props.focus()?.unavailable === undefined;
  // The model choices for a list-declaring Harness, `Harness default` first.
  const modelOptions = (): readonly string[] => {
    const decl = declaration();
    return decl?.kind === "list"
      ? [HARNESS_DEFAULT, ...decl.models]
      : [HARNESS_DEFAULT];
  };
  const modelLabel = () => props.model() ?? HARNESS_DEFAULT;
  const cycleModel = (delta: number) => {
    const options = modelOptions();
    if (options.length <= 1) return;
    const index = Math.max(0, options.indexOf(modelLabel()));
    const next = (index + delta + options.length) % options.length;
    const chosen = options[next] ?? HARNESS_DEFAULT;
    props.setModel(chosen === HARNESS_DEFAULT ? undefined : chosen);
  };
  const editModel = (value: string) => {
    // Store the trimmed model: nothing downstream trims (Preflight matches the
    // free-text model verbatim), so a stray leading/trailing space would fail an
    // otherwise-valid model. Blank still means `Harness default`.
    const trimmed = value.trim();
    props.setModel(trimmed.length === 0 ? undefined : trimmed);
  };

  const tryContinue = () => {
    if (available()) props.onContinue();
  };

  // List phase: move the highlight (spawn-free) and choose a Harness. `q` quits —
  // no text field is focused here.
  useBindings(() => ({
    enabled: phase() === "list" && dialog.stack.length === 0,
    bindings: [
      {
        key: "up",
        desc: "Previous Harness",
        group: "Harness",
        cmd: () => move(-1),
      },
      {
        key: "down",
        desc: "Next Harness",
        group: "Harness",
        cmd: () => move(1),
      },
      {
        key: "return",
        desc: "Choose Harness",
        group: "Harness",
        cmd: () => chooseHighlighted(),
      },
      {
        key: "escape",
        desc: "Back",
        group: "Harness",
        cmd: () => props.onBack(),
      },
      { key: "q", desc: "Quit", group: "Harness", cmd: () => exit() },
      { key: "ctrl+c", desc: "Quit", group: "Harness", cmd: () => exit() },
    ],
  }));
  // Model phase, common: Enter continues (gated on the chosen Harness being
  // available), Escape returns to the list to choose another. `q` is bound only when
  // no free-text field is focused (below) — never while it is, per the keymap rule.
  useBindings(() => ({
    enabled: phase() === "model" && dialog.stack.length === 0,
    bindings: [
      {
        key: "return",
        desc: "Continue",
        group: "Harness",
        cmd: () => tryContinue(),
      },
      {
        key: "escape",
        desc: "Choose another Harness",
        group: "Harness",
        cmd: () => setPhase("list"),
      },
      { key: "ctrl+c", desc: "Quit", group: "Harness", cmd: () => exit() },
    ],
  }));
  // No free-text field is focused for the list or default-only variants, so `q`
  // quits there; the list variant also cycles the model with ←/→.
  useBindings(() => ({
    enabled:
      phase() === "model" &&
      modelMode() !== "free-text" &&
      dialog.stack.length === 0,
    bindings: [{ key: "q", desc: "Quit", group: "Harness", cmd: () => exit() }],
  }));
  useBindings(() => ({
    enabled:
      phase() === "model" &&
      modelMode() === "list" &&
      available() &&
      dialog.stack.length === 0,
    bindings: [
      {
        key: "left",
        desc: "Previous model",
        group: "Harness",
        cmd: () => cycleModel(-1),
      },
      {
        key: "right",
        desc: "Next model",
        group: "Harness",
        cmd: () => cycleModel(1),
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
        Choose a Harness
      </text>
      <StepCount label={props.stepLabel} />
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
      <Switch>
        <Match when={phase() === "list"}>
          <box flexDirection="column" flexGrow={1} overflow="hidden">
            <For each={props.rows()}>
              {(harness, index) => (
                <box flexDirection="column" flexShrink={0}>
                  <text
                    fg={index() === highlight() ? theme.text : theme.textMuted}
                    attributes={
                      index() === highlight() ? TextAttributes.BOLD : 0
                    }
                    flexShrink={0}
                  >
                    {`${index() === highlight() ? "› " : "  "}${harness.name} (${harness.id}) — ${harnessRowStatus(harness)}`}
                  </text>
                  <text fg={theme.textMuted} flexShrink={0}>
                    {`  ${discoveryWord(harness.discovery)}`}
                  </text>
                </box>
              )}
            </For>
          </box>
          <text fg={theme.text} flexShrink={0}>
            ↑/↓ move · enter choose · esc back · q quit
          </text>
        </Match>
        <Match when={phase() === "model"}>
          <ModelField
            harness={chosenHarnessName}
            focus={props.focus}
            mode={modelMode}
            available={available}
            modelLabel={modelLabel}
            modelOptions={modelOptions}
            model={props.model}
            editModel={editModel}
          />
        </Match>
      </Switch>
    </box>
  );

  function chosenHarnessName(): string {
    const harness =
      props.rows().find((row) => row.id === props.chosenId()) ??
      props.rows()[highlight()];
    return harness === undefined
      ? (props.chosenId() ?? "(none)")
      : `${harness.name} (${harness.id})`;
  }
}

function ModelField(props: {
  harness: () => string;
  focus: Accessor<HarnessFocus | undefined>;
  mode: Accessor<"list" | "free-text" | "default-only">;
  available: Accessor<boolean>;
  modelLabel: Accessor<string>;
  modelOptions: Accessor<readonly string[]>;
  model: Accessor<string | undefined>;
  editModel: (value: string) => void;
}) {
  const { theme } = useTheme();
  const dimensions = useTerminalDimensions();
  const inputWidth = () => Math.max(10, dimensions().width - 4);
  const focus = () => props.focus();

  return (
    <box flexDirection="column" gap={1} flexGrow={1} overflow="hidden">
      <box flexDirection="column" flexShrink={0}>
        <text fg={theme.text} flexShrink={0}>
          {`Harness: ${props.harness()}`}
        </text>
        <Show
          when={focus()}
          fallback={
            <text fg={theme.textMuted} flexShrink={0}>
              Qualifying…
            </text>
          }
        >
          {(resolved) => (
            <text fg={theme.textMuted} flexShrink={0}>
              {qualificationWord(resolved().qualification)}
            </text>
          )}
        </Show>
      </box>
      <Show
        when={props.available()}
        fallback={
          <Show when={focus()?.unavailable}>
            {(unavailable) => (
              <box flexDirection="column" flexShrink={0}>
                <text fg={theme.warning} flexShrink={0}>
                  {`Unavailable · ${unavailable().explanation}`}
                </text>
                <text fg={theme.textMuted} flexShrink={0}>
                  {unavailable().remediation}
                </text>
                <text fg={theme.textMuted} flexShrink={0}>
                  esc to choose another Harness
                </text>
              </box>
            )}
          </Show>
        }
      >
        <box flexDirection="column" flexShrink={0}>
          <text fg={theme.textMuted} flexShrink={0}>
            Model
          </text>
          <Switch>
            <Match when={props.mode() === "list"}>
              <text fg={theme.text} flexShrink={0}>
                {`‹ ${props.modelLabel()} › — ←/→ to choose from: ${props
                  .modelOptions()
                  .join(", ")}`}
              </text>
            </Match>
            <Match when={props.mode() === "free-text"}>
              <box flexDirection="column" flexShrink={0}>
                <input
                  focused
                  width={inputWidth()}
                  value={props.model() ?? ""}
                  onInput={(value: string) => props.editModel(value)}
                />
                <text fg={theme.textMuted} flexShrink={0}>
                  Leave blank for Harness default.
                </text>
              </box>
            </Match>
            <Match when={props.mode() === "default-only"}>
              <text fg={theme.text} flexShrink={0}>
                {`${HARNESS_DEFAULT} — this Harness manages its own model.`}
              </text>
            </Match>
          </Switch>
        </box>
      </Show>
      <text fg={theme.textMuted} flexShrink={0}>
        {!props.available()
          ? "esc choose another Harness · ctrl+c quit"
          : props.mode() === "list"
            ? "←/→ model · enter continue · esc choose another · q quit"
            : props.mode() === "free-text"
              ? "type model · enter continue · esc choose another"
              : "enter continue · esc choose another · q quit"}
      </text>
    </box>
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
  stepLabel: Accessor<string>;
  onContinue: () => void;
  onBack: () => void;
}) {
  const { theme } = useTheme();
  const exit = useExit();
  const dialog = useDialog();
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
    enabled: dialog.stack.length === 0,
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
    enabled: choiceLike() && dialog.stack.length === 0,
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
      <StepCount label={props.stepLabel} />
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
  harness: Accessor<HarnessSummary | undefined>;
  model: Accessor<string | undefined>;
  values: Record<string, string>;
  stepLabel: Accessor<string>;
  onStart: () => void;
  onBack: () => void;
}) {
  const { theme } = useTheme();
  const exit = useExit();
  const dialog = useDialog();
  const dimensions = useTerminalDimensions();

  useBindings(() => ({
    enabled: dialog.stack.length === 0,
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
      <StepCount label={props.stepLabel} />
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
            <Show when={routingNeedsHarness(bundle().routing)}>
              <text fg={theme.text} flexShrink={0}>
                {`Harness: ${props.harness()?.name ?? "(not selected)"} (${props.harness()?.id ?? "none"}) · model ${props.model() ?? HARNESS_DEFAULT}`}
              </text>
            </Show>
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
  const dialog = useDialog();
  useBindings(() => ({
    enabled: dialog.stack.length === 0,
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
