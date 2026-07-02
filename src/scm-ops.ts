import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 120_000;

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface RawSshOpts {
  sshPrivateKey: string;
  sshPassphrase?: string;
}

interface RunGitOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

// ---------- Plain (no-SSH) git wrapper ----------

export function runGitPlain(
  args: string[],
  opts: RunGitOpts = {},
): Promise<GitRunResult> {
  return new Promise((resolve) => {
    const spawnOpts: SpawnOptionsWithoutStdio = {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      env: { ...process.env, ...(opts.env ?? {}) },
    };
    const proc = spawn("git", args, spawnOpts);
    const chunksOut: Buffer[] = [];
    const chunksErr: Buffer[] = [];
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* swallow */
      }
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    proc.stdout?.on("data", (b: Buffer) => chunksOut.push(b));
    proc.stderr?.on("data", (b: Buffer) => chunksErr.push(b));
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(chunksOut).toString("utf8").trim(),
        stderr: Buffer.concat(chunksErr).toString("utf8").trim(),
      });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: "", stderr: err.message });
    });
  });
}

// ---------- SSH-wired helpers ----------

interface SshScope {
  scopeDir: string;
  sshCommand: string;
  askpassPath: string | null;
  cleanup: () => Promise<void>;
}

async function provisionSshScope(opts: RawSshOpts): Promise<SshScope> {
  const scopeDir = await mkdtemp(join(tmpdir(), "devdock-git-"));
  await chmod(scopeDir, 0o700);
  const keyPath = join(scopeDir, "id");
  let normalised = opts.sshPrivateKey.replace(/\r\n/g, "\n");
  if (!normalised.endsWith("\n")) normalised += "\n";
  await writeFile(keyPath, normalised, { mode: 0o600 });
  await chmod(keyPath, 0o600);

  const knownHostsPath = join(scopeDir, "known_hosts");
  await writeFile(knownHostsPath, "", { mode: 0o600 });

  let askpassPath: string | null = null;
  if (opts.sshPassphrase !== undefined && opts.sshPassphrase.length > 0) {
    askpassPath = join(scopeDir, "askpass.sh");
    const escaped = opts.sshPassphrase.replace(/'/g, "'\\''");
    await writeFile(
      askpassPath,
      `#!/bin/sh\nprintf '%s' '${escaped}'\n`,
      { mode: 0o700 },
    );
    await chmod(askpassPath, 0o700);
  }

  const sshCommand = [
    "ssh",
    "-F",
    "/dev/null",
    "-i",
    JSON.stringify(keyPath),
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    `UserKnownHostsFile=${JSON.stringify(knownHostsPath).replace(/^"|"$/g, "")}`,
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "BatchMode=yes",
  ].join(" ");

  const cleanup = async (): Promise<void> => {
    try {
      await rm(scopeDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };

  return { scopeDir, sshCommand, askpassPath, cleanup };
}

async function runGitWithSsh(
  args: string[],
  ssh: RawSshOpts,
  opts: RunGitOpts = {},
): Promise<GitRunResult> {
  const scope = await provisionSshScope(ssh);
  try {
    const env: Record<string, string> = {
      ...(opts.env ?? {}),
      GIT_SSH_COMMAND: scope.sshCommand,
      GIT_TERMINAL_PROMPT: "0",
    };
    if (scope.askpassPath !== null) {
      env.SSH_ASKPASS = scope.askpassPath;
      env.SSH_ASKPASS_REQUIRE = "force";
      env.DISPLAY = env.DISPLAY ?? ":0";
    }
    return await runGitPlain(args, { ...opts, env });
  } finally {
    await scope.cleanup();
  }
}

// ---------- Public: clone / fetch / push ----------

export interface CloneOpts {
  remoteUrl: string;
  destPath: string;
  branch?: string;
  ssh: RawSshOpts;
  timeoutMs?: number;
}

export async function cloneRepoWithSsh(opts: CloneOpts): Promise<void> {
  if (existsSync(opts.destPath)) {
    throw new Error(
      `cloneRepoWithSsh: destination already exists: ${opts.destPath}`,
    );
  }
  const args = ["clone"];
  if (opts.branch !== undefined && opts.branch.length > 0) {
    args.push("--branch", opts.branch);
  }
  args.push(opts.remoteUrl, opts.destPath);
  const result = await runGitWithSsh(args, opts.ssh, {
    timeoutMs: opts.timeoutMs ?? 240_000,
  });
  if (result.code !== 0) {
    throw new Error(
      `git clone failed (code=${result.code}): ${result.stderr.slice(0, 400) || result.stdout.slice(0, 400)}`,
    );
  }
}

export interface FetchOpts {
  repoPath: string;
  ssh: RawSshOpts;
  timeoutMs?: number;
}

export async function fetchAllWithSsh(opts: FetchOpts): Promise<void> {
  const result = await runGitWithSsh(
    ["fetch", "--all", "--prune"],
    opts.ssh,
    { cwd: opts.repoPath, timeoutMs: opts.timeoutMs ?? 120_000 },
  );
  if (result.code !== 0) {
    throw new Error(
      `git fetch failed (code=${result.code}): ${result.stderr.slice(0, 400)}`,
    );
  }
}

export interface PushOpts {
  repoPath: string;
  branch: string;
  setUpstream: boolean;
  ssh: RawSshOpts;
  timeoutMs?: number;
}

export async function pushBranchWithSsh(opts: PushOpts): Promise<void> {
  const args = ["push"];
  if (opts.setUpstream) args.push("--set-upstream", "origin", opts.branch);
  else args.push("origin", opts.branch);
  const result = await runGitWithSsh(args, opts.ssh, {
    cwd: opts.repoPath,
    timeoutMs: opts.timeoutMs ?? 120_000,
  });
  if (result.code !== 0) {
    throw new Error(
      `git push failed (code=${result.code}): ${result.stderr.slice(0, 400)}`,
    );
  }
}

// ---------- Public: local-only ops (no SSH) ----------

export interface CloneHttpsOpts {
  remoteUrl: string;
  destPath: string;
  branch?: string;
  timeoutMs?: number;
}

export async function cloneRepoHttps(opts: CloneHttpsOpts): Promise<void> {
  if (existsSync(opts.destPath)) {
    throw new Error(
      `cloneRepoHttps: destination already exists: ${opts.destPath}`,
    );
  }
  const args = ["clone"];
  if (opts.branch !== undefined && opts.branch.length > 0) {
    args.push("--branch", opts.branch);
  }
  args.push(opts.remoteUrl, opts.destPath);
  const result = await runGitPlain(args, {
    timeoutMs: opts.timeoutMs ?? 240_000,
    env: { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GCM_INTERACTIVE: "never" },
  });
  if (result.code !== 0) {
    throw new Error(
      `git clone failed (code=${result.code}): ${result.stderr.slice(0, 400) || result.stdout.slice(0, 400)}`,
    );
  }
}

export async function initRepo(opts: {
  repoPath: string;
  defaultBranch: string;
}): Promise<void> {
  const withFlag = await runGitPlain(
    ["init", "-b", opts.defaultBranch, opts.repoPath],
    {},
  );
  if (withFlag.code === 0) return;
  const plain = await runGitPlain(["init", opts.repoPath], {});
  if (plain.code !== 0) {
    throw new Error(`git init failed: ${plain.stderr.slice(0, 200)}`);
  }
  const sym = await runGitPlain(
    ["symbolic-ref", "HEAD", `refs/heads/${opts.defaultBranch}`],
    { cwd: opts.repoPath },
  );
  if (sym.code !== 0) {
    throw new Error(
      `git symbolic-ref HEAD failed: ${sym.stderr.slice(0, 200)}`,
    );
  }
}

export async function setRemoteOrigin(
  repoPath: string,
  url: string,
): Promise<void> {
  const add = await runGitPlain(["remote", "add", "origin", url], {
    cwd: repoPath,
  });
  if (add.code === 0) return;
  const setUrl = await runGitPlain(["remote", "set-url", "origin", url], {
    cwd: repoPath,
  });
  if (setUrl.code !== 0) {
    throw new Error(
      `git remote add/set-url origin failed: ${setUrl.stderr.slice(0, 200)}`,
    );
  }
}

export async function currentBranch(repoPath: string): Promise<string> {
  const r = await runGitPlain(["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoPath,
  });
  if (r.code !== 0) {
    throw new Error(
      `git rev-parse --abbrev-ref HEAD failed: ${r.stderr.slice(0, 200)}`,
    );
  }
  return r.stdout.trim();
}

export async function workingTreeStatus(
  repoPath: string,
): Promise<Record<string, string>> {
  const r = await runGitPlain(
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: repoPath },
  );
  if (r.code !== 0) {
    throw new Error(`git status failed: ${r.stderr.slice(0, 200)}`);
  }
  const out: Record<string, string> = {};
  for (const line of r.stdout.split("\n")) {
    if (line.length === 0) continue;
    const status = line.slice(0, 2);
    const path = line.slice(3);
    out[path] = status;
  }
  return out;
}

export async function checkoutNewBranch(
  repoPath: string,
  branch: string,
): Promise<void> {
  const r = await runGitPlain(["checkout", "-b", branch], { cwd: repoPath });
  if (r.code !== 0) {
    throw new Error(
      `git checkout -b ${branch} failed: ${r.stderr.slice(0, 200)}`,
    );
  }
}

export async function stageAllAndCommit(
  repoPath: string,
  message: string,
  authorName?: string,
  authorEmail?: string,
): Promise<{ committed: boolean }> {
  const add = await runGitPlain(["add", "-A"], { cwd: repoPath });
  if (add.code !== 0) {
    throw new Error(`git add -A failed: ${add.stderr.slice(0, 200)}`);
  }
  const diff = await runGitPlain(["diff", "--cached", "--name-only"], {
    cwd: repoPath,
  });
  if (diff.code !== 0) {
    throw new Error(`git diff --cached failed: ${diff.stderr.slice(0, 200)}`);
  }
  if (diff.stdout.trim().length === 0) {
    return { committed: false };
  }
  const env: Record<string, string> = {};
  if (authorName !== undefined) {
    env.GIT_AUTHOR_NAME = authorName;
    env.GIT_COMMITTER_NAME = authorName;
  }
  if (authorEmail !== undefined) {
    env.GIT_AUTHOR_EMAIL = authorEmail;
    env.GIT_COMMITTER_EMAIL = authorEmail;
  }
  const commit = await runGitPlain(["commit", "-m", message], {
    cwd: repoPath,
    env,
  });
  if (commit.code !== 0) {
    throw new Error(`git commit failed: ${commit.stderr.slice(0, 200)}`);
  }
  return { committed: true };
}

export async function stageAll(repoPath: string): Promise<void> {
  const add = await runGitPlain(["add", "-A"], { cwd: repoPath });
  if (add.code !== 0) {
    throw new Error(`git add -A failed: ${add.stderr.slice(0, 200)}`);
  }
}

export async function defaultRemoteBranch(repoPath: string): Promise<string> {
  const r = await runGitPlain(
    ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    { cwd: repoPath },
  );
  if (r.code === 0) {
    const m = /^refs\/remotes\/origin\/(.+)$/.exec(r.stdout.trim());
    if (m !== null && m[1] !== undefined) return m[1];
  }
  for (const candidate of ["main", "master"]) {
    const probe = await runGitPlain(
      ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`],
      { cwd: repoPath },
    );
    if (probe.code === 0) return candidate;
  }
  return "main";
}
