import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import {
  createMemo,
  createSignal,
  For,
  Show,
  Switch,
  Match,
  type Accessor,
} from "solid-js";
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
import {
  discoveryWord,
  harnessRowStatus,
  qualificationWord,
} from "./harness-format.js";
import { useBindings } from "./keymap.js";
import { useLaunchPreparationView } from "./launch-preparation-view.js";
import { useExit } from "./vendor/exit.js";
import { useDialog } from "./vendor/dialog.js";
import { useTheme } from "./vendor/theme-context.js";
import { useWorkspaceView } from "./workspace-view.js";

// Pure presentational leaves and step components for the Start-a-Run flow. The draft
// signal, step transitions, refusal routing, and the interleaved key dispatcher stay
// in start-run.tsx; these views receive only Accessors and callbacks from that owner.

const NARROW_BREAKPOINT = 60;

// `Harness default` means no requested model: the Harness's own configuration
// decides. It is the first option in both the list and free-text model fields.
const HARNESS_DEFAULT = "Harness default";

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

export function routingNeedsHarness(
  routing: readonly RoutingNodeView[],
): boolean {
  return routing.some((node) => {
    const steps = node.node === "step" ? [node.step] : node.steps;
    return steps.some((step) => {
      return step.kind === "agent" || step.kind === "interactive-agent";
    });
  });
}

function workspaceName(path: string): string {
  const withoutTrailingSeparator = path.replace(/[\\/]+$/, "");
  return withoutTrailingSeparator.split(/[\\/]/).at(-1) ?? path;
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

function RunNotStartedNotice(props: {
  notice: Accessor<string | undefined>;
  onDismiss: () => void;
  group: string;
}) {
  const { theme } = useTheme();
  const dialog = useDialog();
  useBindings(() => ({
    enabled: props.notice() !== undefined && dialog.stack.length === 0,
    bindings: [
      {
        key: "ctrl+d",
        desc: "Dismiss notice",
        group: props.group,
        cmd: props.onDismiss,
      },
    ],
  }));
  return (
    <Show when={props.notice()}>
      {(message) => (
        <text fg={theme.warning} flexShrink={0}>
          {`ⓘ ${message()} · ctrl+d dismiss`}
        </text>
      )}
    </Show>
  );
}

// --- choose ----------------------------------------------------------------

export function ChooseStep(props: {
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
  notice: Accessor<string | undefined>;
  onDismissNotice: () => void;
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
      <RunNotStartedNotice
        notice={props.notice}
        onDismiss={props.onDismissNotice}
        group="Start a Run"
      />
      <Show when={props.problem()}>
        {(problem) => (
          <box flexDirection="column" flexShrink={0}>
            <text attributes={TextAttributes.BOLD} fg={theme.error}>
              Correction needed
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

export function HarnessStep(props: {
  rows: Accessor<readonly HarnessSummary[]>;
  chosenId: Accessor<string | undefined>;
  findingHarnessId: Accessor<string | undefined>;
  choose: (id: string) => void;
  focus: Accessor<HarnessFocus | undefined>;
  model: Accessor<string | undefined>;
  setModel: (model: string | undefined) => void;
  stepLabel: Accessor<string>;
  problem: Accessor<Problem | undefined>;
  notice: Accessor<string | undefined>;
  onDismissNotice: () => void;
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
  const initialIndex = () =>
    Math.max(
      0,
      props
        .rows()
        .findIndex(
          (harness) =>
            harness.id === (props.chosenId() ?? props.findingHarnessId()),
        ),
    );
  const [highlight, setHighlight] = createSignal(
    props.chosenId() === undefined && props.findingHarnessId() === undefined
      ? 0
      : initialIndex(),
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
      <RunNotStartedNotice
        notice={props.notice}
        onDismiss={props.onDismissNotice}
        group="Harness"
      />
      <Show when={props.problem()}>
        {(problem) => (
          <box flexDirection="column" flexShrink={0}>
            <text attributes={TextAttributes.BOLD} fg={theme.error}>
              Correction needed
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

export function InputsStep(props: {
  bundle: Accessor<InstalledBundleFocus | undefined>;
  values: Record<string, string>;
  setValue: (name: string, value: string) => void;
  findings: Accessor<readonly FieldViolation[] | undefined>;
  problem: Accessor<Problem | undefined>;
  notice: Accessor<string | undefined>;
  onDismissNotice: () => void;
  stepLabel: Accessor<string>;
  onContinue: () => void;
  onBack: () => void;
}) {
  const { theme } = useTheme();
  const exit = useExit();
  const dialog = useDialog();
  const dimensions = useTerminalDimensions();
  const inputs = () => props.bundle()?.launchInputs ?? [];
  const firstInvalidated = () => {
    const finding = props.findings()?.[0];
    if (finding === undefined) return 0;
    return Math.max(
      0,
      inputs().findIndex((input) => input.name === finding.field),
    );
  };
  const [field, setField] = createSignal(firstInvalidated());
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
      <RunNotStartedNotice
        notice={props.notice}
        onDismiss={props.onDismissNotice}
        group="Launch inputs"
      />
      <Show when={props.findings() !== undefined}>
        <box flexDirection="column" flexShrink={0}>
          <text fg={theme.error}>
            One or more inputs are missing or invalid.
          </text>
          <Show when={props.problem()}>
            {(problem) => (
              <text fg={theme.textMuted}>{problem().remediation}</text>
            )}
          </Show>
        </box>
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

export function ReviewStep(props: {
  bundle: Accessor<InstalledBundleFocus | undefined>;
  harness: Accessor<HarnessSummary | undefined>;
  model: Accessor<string | undefined>;
  draft: Accessor<LaunchRunInput>;
  canAcknowledgeTrust: Accessor<boolean>;
  onAcknowledgeTrust: () => void;
  stepLabel: Accessor<string>;
  notice: Accessor<string | undefined>;
  onDismissNotice: () => void;
  onStart: (draft: LaunchRunInput) => void;
  onBack: () => void;
}) {
  const { theme } = useTheme();
  const exit = useExit();
  const dialog = useDialog();
  const dimensions = useTerminalDimensions();
  const preparation = useLaunchPreparationView();
  const workspace = useWorkspaceView();
  const openedAssessment = createMemo(() => preparation.open(props.draft()));
  const assessment = () => openedAssessment()();
  const launchOffer = () =>
    assessment().actionOffers.find((offer) => offer.action === "launch-run");
  const canStart = () =>
    assessment().status === "ready" && launchOffer() !== undefined;
  const trustPosture = () => {
    if (
      assessment().findings.some((finding) => finding.correction === "trust")
    ) {
      return "Trust: Acknowledgement required";
    }
    if (assessment().draft.trustDigest !== undefined) {
      return "Trust: Exact digest acknowledged for this launch";
    }
    return assessment().status === "assessing"
      ? "Trust: Checking"
      : "Trust: Already trusted";
  };

  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: [
      {
        key: "return",
        desc: "Start Run",
        group: "Review",
        cmd: () => {
          const offer = launchOffer();
          if (assessment().status === "ready" && offer !== undefined) {
            props.onStart(offer.draft);
          }
        },
      },
      {
        key: "a",
        desc: "Acknowledge trust",
        group: "Review",
        cmd: () => {
          if (props.canAcknowledgeTrust()) props.onAcknowledgeTrust();
        },
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
      gap={dimensions().height < 24 ? 0 : 1}
      overflow="hidden"
      backgroundColor={theme.background}
    >
      <text attributes={TextAttributes.BOLD} fg={theme.text} flexShrink={0}>
        Review
      </text>
      <StepCount label={props.stepLabel} />
      <RunNotStartedNotice
        notice={props.notice}
        onDismiss={props.onDismissNotice}
        group="Review"
      />
      <Show when={assessment().status === "assessing"}>
        <text fg={theme.textMuted} flexShrink={0}>
          Checking launch
        </text>
      </Show>
      <Show when={assessment().status === "ready"}>
        <text fg={theme.success} flexShrink={0}>
          Ready to start
        </text>
      </Show>
      <Show when={assessment().status === "not-ready"}>
        <text fg={theme.warning} flexShrink={0}>
          Not ready
        </text>
      </Show>
      <For each={assessment().findings}>
        {(finding) => (
          <box flexDirection="column" flexShrink={0}>
            <text fg={theme.warning}>{finding.explanation}</text>
            <text fg={theme.textMuted}>{finding.remediation}</text>
          </box>
        )}
      </For>
      <Show
        when={props.bundle()}
        fallback={<text fg={theme.error}>No Bundle selected.</text>}
      >
        {(bundle) => (
          <box flexDirection="column" flexGrow={1} overflow="hidden">
            <text fg={theme.text} flexShrink={0}>
              {`Workflow: ${formatRouting(bundle().routing)}`}
            </text>
            <text fg={theme.text} flexShrink={0}>
              {`Bundle: ${assessment().draft.bundle.name ?? bundle().name} (${assessment().draft.bundle.id}@${assessment().draft.bundle.version ?? bundle().version})`}
            </text>
            <text fg={theme.textMuted} flexShrink={0}>
              {`Bundle digest: sha256:${assessment().draft.bundle.digest ?? bundle().digest}`}
            </text>
            <text fg={theme.text} flexShrink={0}>
              {`Workspace: ${workspaceName(workspace.snapshot().path)} · ${workspace.snapshot().path}`}
            </text>
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
                <text fg={theme.textMuted}>Launch inputs:</text>
                <For each={bundle().launchInputs}>
                  {(input) => (
                    <text fg={theme.text}>
                      {`  ${input.name}: ${assessment().draft.launchInputs[input.name] ?? "(not set)"}`}
                    </text>
                  )}
                </For>
              </box>
            </Show>
            <text fg={theme.text} flexShrink={0}>
              {trustPosture()}
            </text>
          </box>
        )}
      </Show>
      <text fg={theme.textMuted} flexShrink={0}>
        {canStart()
          ? "enter start · esc back · q quit"
          : props.canAcknowledgeTrust()
            ? "a acknowledge trust · esc back · q quit"
            : "start unavailable · esc back · q quit"}
      </text>
    </box>
  );
}

// --- pending ---------------------------------------------------------------

export function PendingStep() {
  const { theme } = useTheme();
  const dimensions = useTerminalDimensions();
  const exit = useExit();
  const dialog = useDialog();
  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: [
      { key: "q", desc: "Quit", group: "Checking launch", cmd: () => exit() },
      {
        key: "ctrl+c",
        desc: "Quit",
        group: "Checking launch",
        cmd: () => exit(),
      },
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
        Checking launch
      </text>
    </box>
  );
}
