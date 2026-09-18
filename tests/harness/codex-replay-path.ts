import { sep } from "node:path";

export function replayRecordedLine(
  line: string,
  workspace: string,
  separator = sep,
): string {
  const escapedWorkspace = JSON.stringify(workspace).slice(1, -1);
  const escapedSeparator = JSON.stringify(separator).slice(1, -1);
  return line
    .replaceAll("«WORKSPACE»/", `${escapedWorkspace}${escapedSeparator}`)
    .replaceAll("«WORKSPACE»", escapedWorkspace);
}
