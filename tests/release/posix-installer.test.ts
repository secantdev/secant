import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import nodeTest from "node:test";
import {
  CHECKSUMS_FILE,
  LICENSE_FILE,
  MANIFEST_FILE,
  NOTICES_FILE,
  sha256,
} from "../../scripts/assemble.js";
import { makeTempDir } from "../helpers/tempDir.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const INSTALLER = join(PROJECT_ROOT, "install.sh");
const VERSION = "9.8.7-test";
const test = process.platform === "win32" ? nodeTest.skip : nodeTest;

function fakeSystemCommands(os: string, cpu: string): string {
  const directory = makeTempDir("secant-installer-commands-");
  const executable = join(directory, "uname");
  writeFileSync(
    executable,
    `#!/bin/sh
case "$1" in
  -s) printf '%s\\n' '${os}' ;;
  -m) printf '%s\\n' '${cpu}' ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(executable, 0o755);
  if (os === "Darwin") {
    const codesign = join(directory, "codesign");
    writeFileSync(codesign, "#!/bin/sh\nexit 0\n");
    chmodSync(codesign, 0o755);
  }
  return directory;
}

function runInstaller(options: {
  commandsDirectory?: string;
  os: string;
  cpu: string;
  home?: string;
  args?: readonly string[];
  extraEnv?: Readonly<Record<string, string>>;
}) {
  const home = options.home ?? makeTempDir("secant-installer-home-");
  mkdirSync(home, { recursive: true });
  const commandsDirectory =
    options.commandsDirectory ?? fakeSystemCommands(options.os, options.cpu);
  return spawnSync("sh", [INSTALLER, ...(options.args ?? [])], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...options.extraEnv,
      HOME: home,
      PATH: `${commandsDirectory}:${process.env.PATH}`,
      SECANT_HOME: join(home, "application-data-must-not-be-used"),
      SHELL: "/bin/zsh",
    },
  });
}

function addFakeCurl(commandsDirectory: string): void {
  const executable = join(commandsDirectory, "curl");
  writeFileSync(
    executable,
    `#!/bin/sh
url=''
output=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output=$2; shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
printf '%s\\n' "$url" >>"$SECANT_TEST_DOWNLOAD_LOG"
cp "$SECANT_TEST_CANDIDATE_DIR/\${url##*/}" "$output"
`,
  );
  chmodSync(executable, 0o755);
}

function makeCandidate(options?: {
  candidateVersion?: string;
  binaryVersion?: string;
  extraArchiveFile?: string;
  manifestArchiveDigest?: string;
  manifestArchiveType?: string;
  manifestBinaryDigest?: string;
  manifestCpu?: string;
  manifestExecutable?: string;
  manifestOs?: string;
  licenseText?: string;
  noticesText?: string;
  platform?: "linux" | "macos";
  wrongLicenseDigest?: boolean;
  wrongNoticesDigest?: boolean;
}): { archive: string; directory: string; executable: string } {
  const platform = options?.platform ?? "linux";
  const isMac = platform === "macos";
  const targetKey = isMac ? "darwin-arm64" : "linux-x64";
  const cpu = isMac ? "arm64" : "x64";
  const candidateVersion = options?.candidateVersion ?? VERSION;
  const licenseText = options?.licenseText ?? "Secant test license\n";
  const noticesText = options?.noticesText ?? "Secant test notices\n";
  const directory = makeTempDir("secant-installer-candidate-");
  const stage = join(directory, "stage");
  mkdirSync(stage);
  const executable = join(stage, "secant");
  writeFileSync(
    executable,
    `#!/bin/sh\nprintf '%s\\n' '${options?.binaryVersion ?? candidateVersion}'\n`,
  );
  chmodSync(executable, 0o755);
  writeFileSync(join(stage, LICENSE_FILE), licenseText);
  writeFileSync(join(stage, NOTICES_FILE), noticesText);
  const archiveContents = ["secant", LICENSE_FILE, NOTICES_FILE];
  if (options?.extraArchiveFile !== undefined) {
    writeFileSync(join(stage, options.extraArchiveFile), "unexpected\n");
    archiveContents.push(options.extraArchiveFile);
  }

  const archive = isMac ? "secant-darwin-arm64.zip" : "secant-linux-x64.tar.gz";
  const archivePath = join(directory, archive);
  const createArchive = isMac
    ? spawnSync("zip", ["-X", "-q", archivePath, ...archiveContents], {
        cwd: stage,
        encoding: "utf8",
      })
    : spawnSync("tar", ["-czf", archivePath, ...archiveContents], {
        cwd: stage,
        encoding: "utf8",
      });
  assert.equal(createArchive.status, 0, createArchive.stderr);

  const archiveSha256 = sha256(archivePath);
  writeFileSync(
    join(directory, MANIFEST_FILE),
    `${JSON.stringify(
      {
        version: candidateVersion,
        licenseSha256: options?.wrongLicenseDigest
          ? "0".repeat(64)
          : sha256(join(stage, LICENSE_FILE)),
        noticesSha256: options?.wrongNoticesDigest
          ? "0".repeat(64)
          : sha256(join(stage, NOTICES_FILE)),
        targets: [
          {
            key: targetKey,
            os: options?.manifestOs ?? platform,
            cpu: options?.manifestCpu ?? cpu,
            package: `@secantdev/secant-${targetKey}`,
            archive,
            archiveType:
              options?.manifestArchiveType ?? (isMac ? "zip" : "tar.gz"),
            executable: options?.manifestExecutable ?? "secant",
            binarySha256: options?.manifestBinaryDigest ?? sha256(executable),
            archiveSha256: options?.manifestArchiveDigest ?? archiveSha256,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(directory, CHECKSUMS_FILE),
    `${archiveSha256}  ${archive}\n`,
  );
  return { archive: archivePath, directory, executable };
}

nodeTest(
  "the POSIX installer refuses an unsupported target before download",
  () => {
    const result = runInstaller({
      os: "MINGW64_NT-10.0",
      cpu: "x86_64",
      args: ["--candidate-dir", "/does/not/exist"],
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unsupported platform: windows-x64/);
    assert.doesNotMatch(result.stderr, /does\/not\/exist/);
  },
);

test("the POSIX installer verifies and installs a local Linux candidate", () => {
  const candidate = makeCandidate();
  const home = makeTempDir("secant-installer-home-");
  const result = runInstaller({
    os: "Linux",
    cpu: "x86_64",
    home,
    args: [
      "--candidate-dir",
      candidate.directory,
      "--version",
      VERSION,
      "--no-modify-path",
    ],
  });

  assert.equal(result.status, 0, result.stderr);
  const installed = join(home, ".secant", "bin", "secant");
  assert.deepEqual(readFileSync(installed), readFileSync(candidate.executable));
  assert.equal(
    readFileSync(join(home, ".secant", "bin", LICENSE_FILE), "utf8"),
    "Secant test license\n",
  );
  assert.match(result.stdout, /export PATH="\$HOME\/\.secant\/bin:\$PATH"/);
  assert.doesNotMatch(result.stdout, /application-data-must-not-be-used/);
});

test("the POSIX installer installs macOS arm64 with Terminal guidance", () => {
  const candidate = makeCandidate({ platform: "macos" });
  const home = makeTempDir("secant-installer-macos-home-");
  const result = runInstaller({
    os: "Darwin",
    cpu: "arm64",
    home,
    args: ["--candidate-dir", candidate.directory, "--no-modify-path"],
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    readFileSync(join(home, ".secant", "bin", "secant")),
    readFileSync(candidate.executable),
  );
  assert.match(
    result.stdout,
    /Run Secant from Terminal; do not double-click a downloaded executable\./,
  );
  assert.doesNotMatch(result.stdout, /notari|browser/i);
});

test("failed candidate verification preserves an existing installation", () => {
  const candidate = makeCandidate();
  appendFileSync(candidate.archive, "tampered bytes");
  const home = makeTempDir("secant-installer-existing-home-");
  const installDirectory = join(home, ".secant", "bin");
  mkdirSync(installDirectory, { recursive: true });
  const installed = join(installDirectory, "secant");
  writeFileSync(installed, "known working installation\n");

  const result = runInstaller({
    os: "Linux",
    cpu: "x86_64",
    home,
    args: ["--candidate-dir", candidate.directory, "--no-modify-path"],
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /checksum does not match/);
  assert.equal(readFileSync(installed, "utf8"), "known working installation\n");
});

test("a non-managed bin directory is refused without replacement", () => {
  const candidate = makeCandidate();
  const home = makeTempDir("secant-installer-non-managed-home-");
  const installDirectory = join(home, ".secant", "bin");
  mkdirSync(installDirectory, { recursive: true });
  const installed = join(installDirectory, "secant");
  writeFileSync(installed, "unmanaged installation\n");

  const result = runInstaller({
    os: "Linux",
    cpu: "x86_64",
    home,
    args: ["--candidate-dir", candidate.directory, "--no-modify-path"],
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a Secant-managed installation/);
  assert.equal(readFileSync(installed, "utf8"), "unmanaged installation\n");
});

test("replacement switches the executable and legal material as one layout", () => {
  const firstCandidate = makeCandidate();
  const secondCandidate = makeCandidate({
    candidateVersion: "9.8.8-test",
    licenseText: "Secant replacement license\n",
    noticesText: "Secant replacement notices\n",
  });
  const home = makeTempDir("secant-installer-replacement-home-");

  const first = runInstaller({
    os: "Linux",
    cpu: "x86_64",
    home,
    args: ["--candidate-dir", firstCandidate.directory, "--no-modify-path"],
  });
  const second = runInstaller({
    os: "Linux",
    cpu: "x86_64",
    home,
    args: ["--candidate-dir", secondCandidate.directory, "--no-modify-path"],
  });

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const installDirectory = join(home, ".secant", "bin");
  const installedVersion = spawnSync(
    join(installDirectory, "secant"),
    ["--version"],
    {
      encoding: "utf8",
    },
  );
  assert.equal(installedVersion.stdout, "9.8.8-test\n");
  assert.equal(
    readFileSync(join(installDirectory, LICENSE_FILE), "utf8"),
    "Secant replacement license\n",
  );
  assert.equal(
    readFileSync(join(installDirectory, NOTICES_FILE), "utf8"),
    "Secant replacement notices\n",
  );
});

for (const refusal of [
  {
    name: "target identity",
    candidate: () => makeCandidate({ manifestOs: "macos" }),
    message: /target OS identity is invalid/,
  },
  {
    name: "archive layout",
    candidate: () => makeCandidate({ extraArchiveFile: "unexpected" }),
    message: /layout must contain only/,
  },
  {
    name: "legal material",
    candidate: () => makeCandidate({ wrongLicenseDigest: true }),
    message: /LICENSE checksum is invalid/,
  },
  {
    name: "notices material",
    candidate: () => makeCandidate({ wrongNoticesDigest: true }),
    message: /THIRD-PARTY-NOTICES\.md checksum is invalid/,
  },
  {
    name: "target CPU identity",
    candidate: () => makeCandidate({ manifestCpu: "arm64" }),
    message: /target CPU identity is invalid/,
  },
  {
    name: "executable identity",
    candidate: () => makeCandidate({ manifestExecutable: "renamed" }),
    message: /executable identity is invalid/,
  },
  {
    name: "archive type",
    candidate: () => makeCandidate({ manifestArchiveType: "rar" }),
    message: /archive type is invalid/,
  },
  {
    name: "archive manifest digest",
    candidate: () => makeCandidate({ manifestArchiveDigest: "0".repeat(64) }),
    message: /checksum does not match candidate-manifest\.json/,
  },
  {
    name: "executable digest",
    candidate: () => makeCandidate({ manifestBinaryDigest: "0".repeat(64) }),
    message: /executable checksum is invalid/,
  },
  {
    name: "reported version",
    candidate: () => makeCandidate({ binaryVersion: "wrong-version" }),
    message: /reported version wrong-version instead of/,
  },
]) {
  test(`the POSIX installer refuses invalid ${refusal.name}`, () => {
    const candidate = refusal.candidate();
    const result = runInstaller({
      os: "Linux",
      cpu: "x86_64",
      args: ["--candidate-dir", candidate.directory, "--no-modify-path"],
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, refusal.message);
  });
}

test("an exact version mismatch is refused before replacement", () => {
  const candidate = makeCandidate();
  const result = runInstaller({
    os: "Linux",
    cpu: "x86_64",
    args: [
      "--candidate-dir",
      candidate.directory,
      "--version",
      "1.2.3-other",
      "--no-modify-path",
    ],
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match requested version/);
});

test("duplicate candidate-manifest fields are refused as malformed", () => {
  const candidate = makeCandidate();
  const manifestPath = join(candidate.directory, MANIFEST_FILE);
  const manifest = readFileSync(manifestPath, "utf8");
  writeFileSync(
    manifestPath,
    manifest.replace(
      `  "version": "${VERSION}",`,
      `  "version": "${VERSION}",\n  "version": "${VERSION}",`,
    ),
  );

  const result = runInstaller({
    os: "Linux",
    cpu: "x86_64",
    args: ["--candidate-dir", candidate.directory, "--no-modify-path"],
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /manifest version is malformed/);
});

test("an unsafe candidate-manifest version is refused before staging", () => {
  const candidate = makeCandidate({ candidateVersion: "../../outside" });
  const home = makeTempDir("secant-installer-unsafe-version-home-");
  const result = runInstaller({
    os: "Linux",
    cpu: "x86_64",
    home,
    args: ["--candidate-dir", candidate.directory, "--no-modify-path"],
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid candidate version/);
  assert.equal(existsSync(join(home, ".secant")), false);
});

for (const installedFile of ["secant", LICENSE_FILE, NOTICES_FILE]) {
  test(`a corrupted staged ${installedFile} is not reused`, () => {
    const candidate = makeCandidate();
    const home = makeTempDir("secant-installer-corrupt-stage-home-");
    const args = [
      "--candidate-dir",
      candidate.directory,
      "--no-modify-path",
    ] as const;
    const first = runInstaller({ os: "Linux", cpu: "x86_64", home, args });
    assert.equal(first.status, 0, first.stderr);
    writeFileSync(join(home, ".secant", "bin", installedFile), "corrupted\n");

    const second = runInstaller({ os: "Linux", cpu: "x86_64", home, args });

    assert.equal(second.status, 1);
    assert.match(second.stderr, /Existing staged release has (an )?invalid/);
  });
}

for (const source of [
  { name: "latest", args: [] as readonly string[], path: "latest/download" },
  {
    name: "exact",
    args: ["--version", `v${VERSION}`],
    path: `download/v${VERSION}`,
  },
]) {
  test(`${source.name} installation downloads only the matching archive`, () => {
    const candidate = makeCandidate();
    const commandsDirectory = fakeSystemCommands("Linux", "x86_64");
    addFakeCurl(commandsDirectory);
    const downloadLog = join(makeTempDir("secant-download-log-"), "urls");
    const result = runInstaller({
      commandsDirectory,
      os: "Linux",
      cpu: "x86_64",
      args: [...source.args, "--no-modify-path"],
      extraEnv: {
        SECANT_TEST_CANDIDATE_DIR: candidate.directory,
        SECANT_TEST_DOWNLOAD_LOG: downloadLog,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(downloadLog, "utf8").trim().split("\n"), [
      `https://github.com/secantdev/secant/releases/${source.path}/${MANIFEST_FILE}`,
      `https://github.com/secantdev/secant/releases/${source.path}/${CHECKSUMS_FILE}`,
      `https://github.com/secantdev/secant/releases/${source.path}/secant-linux-x64.tar.gz`,
    ]);
  });
}

test("PATH modification is idempotent", () => {
  const candidate = makeCandidate();
  const home = makeTempDir("secant-installer-path-home-");
  const args = ["--candidate-dir", candidate.directory] as const;

  const first = runInstaller({ os: "Linux", cpu: "x86_64", home, args });
  const second = runInstaller({ os: "Linux", cpu: "x86_64", home, args });

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const profile = readFileSync(join(home, ".zshrc"), "utf8");
  assert.equal(
    profile.match(/export PATH="\$HOME\/\.secant\/bin:\$PATH"/g)?.length,
    1,
  );
});
