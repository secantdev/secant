export async function runNamedScenario<Result>(
  name: string,
  scenario: () => Promise<Result>,
): Promise<Result> {
  try {
    return await scenario();
  } catch (cause) {
    throw new Error(`Package smoke scenario "${name}" failed.`, { cause });
  }
}
