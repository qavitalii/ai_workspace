import {
  codexIntegrations,
  codexPluginHome,
  claudeIntegrations,
  packageToolName,
  githubSyncToolName,
} from "./integrations.js";
import { githubSyncBridge } from "./github-sync-bridge.js";
import { drainPackageAudit } from "./package-audit.js";
import { packagePresetResults } from "./package-request.js";
import { codexImageItem } from "./generated-images.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { constants } from "node:fs";
import {
  readFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { projectToolEnvironment } from "../project-tool-environment.js";
import { quotaError, type RunInput, type RunnerCommand } from "../shared.js";
import { claudeSubscriptionUsage } from "../usage.js";
const emit = (data: unknown) =>
  process.stdout.write(JSON.stringify(data) + "\n");
const preinstalledPackages: string[] = [];
const packagePresetReport = process.env.WORKSPACE_PROJECT_PACKAGE_RESULT;
delete process.env.WORKSPACE_PROJECT_PACKAGE_RESULT;
if (packagePresetReport) {
  let results = null;
  let incomplete = true;
  let skipLog: string[] = [];
  try {
    const report = JSON.parse(packagePresetReport);
    results = packagePresetResults(report.results);
    incomplete = report.incomplete !== false;
    if (Array.isArray(report.skipLog))
      skipLog = report.skipLog.filter(
        (entry: unknown) => typeof entry === "string",
      );
  } catch {}
  emit({ type: "project_packages_ready", results: results ?? [] });
  if (results?.length) {
    preinstalledPackages.push(
      ...results.filter(({ ok }) => ok).map(({ name }) => name),
    );
    const failures = results.filter(({ ok }) => !ok).map(({ name }) => name);
    if (failures.length) {
      const summary = failures.slice(0, 3).join(", ");
      const additional = failures.length - 3;
      if (additional > 0)
        emit({
          type: "log",
          projectPackageStartup: true,
          text:
            "Project Debian packages that could not be preinstalled: " +
            failures.join(", "),
        });
      emit({
        type: "warning",
        projectPackageStartup: true,
        message:
          "Could not preinstall project Debian packages: " +
          summary +
          (additional > 0
            ? ` and ${additional} more. See the execution log.`
            : ""),
      });
    }
  }
  if (skipLog.length) {
    emit({
      type: "log",
      projectPackageStartup: true,
      text: "Skipped project Debian packages. " + skipLog.join("\n\n"),
    });
    emit({
      type: "warning",
      projectPackageStartup: true,
      message:
        "Workspace skipped some saved Debian packages. See the execution log.",
    });
  } else if (incomplete || !results)
    emit({
      type: "warning",
      projectPackageStartup: true,
      message:
        "Project Debian package installation did not finish before the agent started.",
    });
}
const githubSync = githubSyncBridge((id) => emit({ type: "github_sync", id }));
function flushPackageAudit() {
  if (process.env.WORKSPACE_SYSTEM_PACKAGES === "1")
    for (const packages of drainPackageAudit())
      emit({ type: "packages_installed", packages });
}
if (process.env.WORKSPACE_SYSTEM_PACKAGES === "1")
  setInterval(flushPackageAudit, 250).unref();
let child: ChildProcessWithoutNullStreams | undefined,
  terminal: any,
  threadId: string | undefined,
  ended = false,
  compacting = false;
const questionAnswers = new Map<
  string,
  (answers: Record<string, { answers: string[] }>) => void
>();
const rpcQuestions = new Map<string, unknown>();
const approvals = new Map<string, (allow: boolean) => void>();
const rpcPending = new Map<
  number,
  { resolve: (x: any) => void; reject: (e: any) => void; timer: NodeJS.Timeout }
>();
const mcpApprovals = new Map<string, unknown>();
const rpcApprovals = new Map<string, unknown>();
let sequence = 0;
function send(value: unknown) {
  child?.stdin.write(JSON.stringify(value) + "\n");
}
function rpc(method: string, params: unknown = {}) {
  const id = ++sequence;
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      rpcPending.delete(id);
      reject(new Error("Codex request timed out: " + method));
    }, 60000);
    rpcPending.set(id, { resolve, reject, timer });
    send({ id, method, params });
  });
}
function finish(type: string, extra: object = {}) {
  if (ended) return;
  ended = true;
  flushPackageAudit();
  emit({ type, ...extra });
}
function processChild(
  command: string,
  args: string[],
  onLine: (line: string) => void,
  environment: Record<string, string> = {},
) {
  child = spawn(command, args, {
    cwd: "/workspace",
    env: {
      ...process.env,
      HOME: "/profile",
      CODEX_HOME: "/profile/.codex",
      CLAUDE_CONFIG_DIR: "/profile/.claude",
      ...environment,
    },
    stdio: "pipe",
  });
  createInterface({ input: child.stdout }).on("line", onLine);
  child.stderr.on("data", (b) =>
    emit({ type: "log", text: b.toString().slice(0, 16000) }),
  );
  child.on("error", (e) => finish("failed", { error: e.message }));
  child.on("exit", (code) => {
    for (const p of rpcPending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Agent exited"));
    }
    rpcPending.clear();
    if (!ended)
      finish("failed", {
        error: "Agent process exited before a final result",
        exitCode: code,
      });
  });
}
async function codex(
  entries: NonNullable<RunInput["integrations"]> = [],
  packageServerName?: string,
  githubSyncPort?: number,
  saveImages = false,
) {
  const integrations = codexIntegrations(
    entries,
    packageServerName,
    githubSyncPort,
  );
  await mkdir("/profile/.codex", { recursive: true });
  const home = await codexPluginHome(entries);
  if (home) {
    integrations.env.CODEX_HOME = home;
    integrations.env.CODEX_SQLITE_HOME = "/profile/.codex";
  }
  processChild(
    "codex",
    [
      "app-server",
      "--listen",
      "stdio://",
      "-c",
      'cli_auth_credentials_store="file"',
      ...integrations.args,
    ],
    (line) => {
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.id !== undefined && !m.method) {
        const p = rpcPending.get(m.id);
        if (p) {
          clearTimeout(p.timer);
          rpcPending.delete(m.id);
          m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
        }
        return;
      }
      const p = m.params || {};
      if (m.id !== undefined) {
        if (
          [
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
          ].includes(m.method)
        ) {
          const id = String(m.id);
          rpcApprovals.set(id, m.id);
          emit({
            type: "approval",
            id,
            description: p.command || p.reason || "Allow file changes?",
            details: p,
          });
        } else if (m.method === "mcpServer/elicitation/request") {
          if (
            p.mode === "form" &&
            p.requestedSchema?.type === "object" &&
            Object.keys(p.requestedSchema.properties ?? {}).length === 0
          ) {
            const id = String(m.id);
            mcpApprovals.set(id, m.id);
            emit({
              type: "approval",
              id,
              description: String(p.serverName) + ": " + String(p.message),
            });
          } else {
            send({
              id: m.id,
              result: { action: "decline", content: null, _meta: null },
            });
            emit({
              type: "log",
              text: "MCP server requested an interactive form or sign-in that Workspace cannot display.",
            });
          }
        } else if (m.method === "item/tool/requestUserInput") {
          const id = String(m.id);
          rpcQuestions.set(id, m.id);
          emit({ type: "question", id, questions: p.questions });
        } else {
          send({
            id: m.id,
            error: {
              code: -32601,
              message: "This client does not support " + m.method,
            },
          });
          emit({ type: "log", text: "Unsupported agent request: " + m.method });
        }
        return;
      }
      if (m.method === "serverRequest/resolved") {
        rpcQuestions.delete(String(p.requestId));
        rpcApprovals.delete(String(p.requestId));
        mcpApprovals.delete(String(p.requestId));
        emit({ type: "request_resolved", id: String(p.requestId) });
      }
      if (m.method === "item/completed" && p.item?.type === "plan")
        emit({ type: "delta", text: "\n\n" + p.item.text });
      if (
        compacting &&
        m.method === "item/completed" &&
        p.item?.type === "contextCompaction"
      )
        finish("completed", {
          result:
            "Agent context compacted. Chat history and workspace files are preserved.",
        });
      if (m.method === "item/agentMessage/delta")
        emit({ type: "delta", text: p.delta });
      if (m.method === "item/commandExecution/outputDelta")
        emit({ type: "log", text: p.delta });
      if (
        m.method === "item/completed" ||
        (m.method === "item/started" && p.item?.type !== "agentMessage")
      ) {
        const completed = m.method === "item/completed";
        const item = codexImageItem(
          p.item,
          completed,
          saveImages
            ? { home: home || "/profile/.codex", threadId }
            : undefined,
          emit,
        );
        emit({ type: completed ? "checkpoint" : "tool", item });
      }
      if (m.method === "account/rateLimits/updated")
        emit({ type: "limits", limits: p.rateLimits });
      if (m.method === "account/login/completed")
        emit({ type: "auth_complete", success: p.success, error: p.error });
      if (m.method === "turn/completed") {
        const t = p.turn;
        const code = t?.error?.codexErrorInfo;
        const reason =
          typeof code === "object" ? Object.keys(code || {})[0] : code;
        if (t?.status === "completed") finish("completed");
        else if (quotaError(reason) || reason === "usageLimitExceeded")
          finish("quota", {
            error: t?.error?.message || "Usage limit reached",
          });
        else
          finish(t?.status === "interrupted" ? "interrupted" : "failed", {
            error: t?.error?.message || t?.status || "Unknown result",
          });
      }
    },
    integrations.env,
  );
  await rpc("initialize", {
    clientInfo: {
      name: "ai_workspace",
      title: "AI Workspace",
      version: "0.1.0",
    },
    capabilities: { experimentalApi: true },
  });
  send({ method: "initialized" });
}
function packageServerFor(input: RunInput) {
  // Project MCP configuration cannot predefine an automatically approved tool
  // if the server name changes with every runner invocation.
  if (
    process.env.WORKSPACE_SYSTEM_PACKAGES === "1" &&
    input.mode !== "plan" &&
    !input.operation
  )
    return "workspace_packages_" + randomBytes(8).toString("hex");
}
function executionPrompt(input: RunInput, packageServerName?: string) {
  let prompt = input.prompt;
  if (input.projectEnvWarning) prompt += "\n\n" + input.projectEnvWarning;
  else if (
    process.env.WORKSPACE_PROJECT_TOOL_PATH &&
    input.mode !== "plan" &&
    !input.operation &&
    (input.provider === "claude" || input.autonomous)
  )
    prompt +=
      "\n\nUser-level tools persist for this project in /env. Use npm install -g or pip install --user for tools the project needs. Other agents of this project share them.";
  if (preinstalledPackages.length)
    prompt +=
      "\n\nPreinstalled project packages: " +
      preinstalledPackages.join(", ") +
      ".";
  if (packageServerName) {
    prompt +=
      "\n\nIf this task needs a system package, call " +
      packageToolName(packageServerName) +
      " with its Debian package name, for example ffmpeg. The tool is the same installer as workspace-install and avoids shell permission prompts.";
    if (process.env.WORKSPACE_PROJECT_TOOL_PATH)
      prompt +=
        " Workspace remembers packages for future runs when automatic remembering is enabled in Project settings.";
  }
  if (input.githubSync)
    prompt += `\n\nWhen the user asks to update this working folder from GitHub, call ${githubSyncToolName} before editing files. It uses the project’s saved GitHub access and stops for local edits or conflicts. Report blocked syncs without resetting or stashing changes.`;
  return prompt;
}
async function runCodex(input: RunInput, githubSyncPort?: number) {
  const packageServerName = packageServerFor(input);
  await codex(
    input.integrations,
    packageServerName,
    githubSyncPort,
    input.mode !== "plan" && (!input.operation || input.operation === "native"),
  );
  const args: any = {
    cwd: "/workspace",
    approvalPolicy:
      input.mode === "plan"
        ? "untrusted"
        : input.autonomous
          ? "never"
          : "untrusted",
    sandbox:
      input.mode === "plan"
        ? "read-only"
        : input.autonomous
          ? "danger-full-access"
          : "workspace-write",
    ...(input.model ? { model: input.model } : {}),
  };
  const r = await rpc(
    input.sessionId ? "thread/resume" : "thread/start",
    input.sessionId ? { ...args, threadId: input.sessionId } : args,
  );
  threadId = r.thread.id;
  emit({ type: "session", id: threadId });
  emit({
    type: "model",
    model: r.model,
    effort: input.effort || r.reasoningEffort || "",
  });
  if (input.operation === "compact") {
    compacting = true;
    await rpc("thread/compact/start", { threadId });
    return;
  }
  if (input.operation === "review") {
    await rpc("review/start", {
      threadId,
      target: input.prompt
        ? { type: "custom", instructions: input.prompt }
        : { type: "uncommittedChanges" },
      delivery: "inline",
    });
    return;
  }
  const prompt: any[] = [
    { type: "text", text: executionPrompt(input, packageServerName) },
  ];
  for (const f of input.attachments)
    if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(f.mime))
      prompt.push({ type: "localImage", path: f.path });
  await rpc("turn/start", {
    threadId,
    input: prompt,
    collaborationMode: {
      mode: input.mode || "default",
      settings: {
        model: input.model || r.model,
        reasoning_effort: input.effort || r.reasoningEffort || null,
        developer_instructions: null,
      },
    },
    ...(input.effort ? { effort: input.effort } : {}),
  });
}
async function readClaudePlan(directory: string) {
  const limit = 128 * 1024;
  try {
    const plans = (await readdir(directory, { withFileTypes: true })).filter(
      (entry) => entry.isFile() && entry.name.endsWith(".md"),
    );
    if (plans.length !== 1) return undefined;
    const file = await open(
      path.join(directory, plans[0].name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      if (!(await file.stat()).isFile()) return undefined;
      const buffer = Buffer.alloc(limit + 1);
      const { bytesRead } = await file.read(buffer);
      if (bytesRead <= limit)
        return buffer.toString("utf8", 0, bytesRead).trim() || undefined;
    } finally {
      await file.close();
    }
  } catch {
    // The native session can still supply the plan if the file was unavailable.
  }
}
async function runClaude(input: RunInput, githubSyncPort?: number) {
  const packageServerName = packageServerFor(input);
  const plansDirectory =
    input.mode === "plan"
      ? await mkdtemp("/tmp/workspace-claude-plan-")
      : undefined;
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/approve") {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const b of req) {
      raw += b;
      if (raw.length > 100000) {
        res.writeHead(413).end();
        return;
      }
    }
    try {
      const p = JSON.parse(raw),
        id = randomUUID();
      let updatedInput = p.input || {};
      let allowed: boolean;
      if (
        p.tool_name === "AskUserQuestion" &&
        Array.isArray(p.input?.questions)
      ) {
        const questions = p.input.questions.map((q: any, i: number) => ({
          ...q,
          id: String(i),
        }));
        emit({ type: "question", id, questions });
        const answers = await new Promise<
          Record<string, { answers: string[] }>
        >((resolve) => questionAnswers.set(id, resolve));
        updatedInput = {
          ...p.input,
          answers: Object.fromEntries(
            questions.map((q: any) => [
              q.question,
              answers[q.id].answers.join(", "),
            ]),
          ),
        };
        allowed = true;
      } else {
        const planExit = !!plansDirectory && p.tool_name === "ExitPlanMode";
        const plan = planExit
          ? typeof p.input?.plan === "string" && p.input.plan.trim()
            ? p.input.plan
            : await readClaudePlan(plansDirectory)
          : undefined;
        emit({
          type: "approval",
          id,
          description: planExit
            ? "Approve the plan and start execution?"
            : p.tool_name === "ExitPlanMode"
              ? "Allow Claude to leave planning mode and implement the plan in this run?"
              : p.tool_name || "Allow this action?",
          details: planExit ? (plan ?? null) : p.input,
          ...(planExit ? { planExit: true } : {}),
        });
        allowed = await new Promise<boolean>((resolve) =>
          approvals.set(id, resolve),
        );
      }
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify(
          allowed
            ? { behavior: "allow", updatedInput }
            : { behavior: "deny", message: "Denied by owner" },
        ),
      );
    } catch {
      res.writeHead(400).end();
    }
  });
  await new Promise<void>((resolve) =>
    server.listen(47831, "127.0.0.1", resolve),
  );
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];
  if (input.sessionId) args.push("--resume", input.sessionId);
  if (plansDirectory)
    args.push("--settings", JSON.stringify({ plansDirectory }));
  if (input.model) args.push("--model", input.model);
  if (input.effort) args.push("--effort", input.effort);
  if (input.autonomous && input.mode !== "plan")
    args.push("--dangerously-skip-permissions");
  else
    args.push(
      "--permission-mode",
      input.mode === "plan" ? "plan" : "default",
      "--permission-prompt-tool",
      "mcp__workspace_permissions__approve",
    );
  args.push(
    ...(await claudeIntegrations(
      input.integrations ?? [],
      !input.autonomous || input.mode === "plan",
      "/workspace",
      packageServerName,
      githubSyncPort,
    )),
  );
  processChild("claude", args, (line) => {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (
      m.type === "system" &&
      m.subtype === "init" &&
      Array.isArray(m.slash_commands)
    )
      emit({ type: "commands", commands: m.slash_commands });
    if (m.type === "system" && m.subtype === "init" && m.model)
      emit({ type: "model", model: m.model, effort: input.effort || "" });
    if (m.type === "system" && m.session_id)
      emit({ type: "session", id: m.session_id });
    if (m.type === "stream_event") {
      const e = m.event;
      if (e.type === "content_block_delta" && e.delta?.type === "text_delta")
        emit({ type: "delta", text: e.delta.text });
      if (
        e.type === "content_block_start" &&
        e.content_block?.type === "tool_use"
      )
        emit({ type: "tool", item: e.content_block });
    }
    if (m.type === "assistant") emit({ type: "checkpoint", item: m.message });
    if (m.type === "rate_limit_event")
      emit({ type: "limits", limits: m.rate_limit_info });
    if (m.type === "result") {
      server.close();
      if (!m.is_error) finish("completed", { result: m.result });
      else if (
        quotaError(m.error) ||
        m.errors?.some((e: any) => quotaError(e?.type))
      )
        finish("quota", { error: m.result || "Usage limit reached" });
      else
        finish("failed", {
          error: m.result || m.errors?.join("\n") || m.subtype,
        });
    }
  });
  const content: any[] = [
    { type: "text", text: executionPrompt(input, packageServerName) },
  ];
  for (const f of input.attachments)
    if (
      ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(f.mime)
    ) {
      const b = await readFile(f.path);
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: f.mime,
          data: b.toString("base64"),
        },
      });
    }
  send({ type: "user", message: { role: "user", content } });
}
async function auth(provider: string) {
  if (provider === "codex") {
    await codex();
    emit({
      ...(await rpc("account/login/start", { type: "chatgptDeviceCode" })),
      type: "auth_url",
    });
  } else {
    const pty = await import("node-pty");
    terminal = pty.spawn("claude", ["auth", "login"], {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: "/workspace",
      env: {
        ...process.env,
        HOME: "/profile",
        CLAUDE_CONFIG_DIR: "/profile/.claude",
      } as any,
    });
    terminal.onData((text: string) => emit({ type: "auth_output", text }));
    terminal.onExit(({ exitCode }: { exitCode: number }) =>
      emit({ type: "auth_complete", success: exitCode === 0 }),
    );
  }
}
// Calls an Anthropic endpoint with the signed-in CLI profile's own OAuth
// token. Never makes inference requests and never rewrites credentials.
async function claudeApi(path: string, headers: Record<string, string> = {}) {
  const credentials = async () => {
    try {
      return JSON.parse(
        await readFile("/profile/.claude/.credentials.json", "utf8"),
      )?.claudeAiOauth;
    } catch {
      return undefined;
    }
  };
  const request = (token: string) =>
    fetch("https://api.anthropic.com" + path, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
        ...headers,
      },
      signal: AbortSignal.timeout(10000),
    });
  let auth = await credentials();
  if (!auth?.accessToken)
    throw new Error("Claude is not signed in on this account.");
  const stale =
    typeof auth.expiresAt === "number" && auth.expiresAt <= Date.now() + 60000;
  let response = stale ? undefined : await request(auth.accessToken);
  if (!response || response.status === 401) {
    // Let the official CLI renew its own token.
    await new Promise<void>((resolve) => {
      const status = spawn("claude", ["auth", "status"], {
        env: {
          ...process.env,
          HOME: "/profile",
          CLAUDE_CONFIG_DIR: "/profile/.claude",
        },
        stdio: "ignore",
        timeout: 15000,
      });
      status.on("error", () => resolve());
      status.on("close", () => resolve());
    });
    auth = await credentials();
    if (auth?.accessToken) response = await request(auth.accessToken);
  }
  if (response?.status === 401 || response?.status === 403)
    throw Object.assign(
      new Error(
        "Claude sign-in needs renewal. It renews on the next task; the latest reported values are shown.",
      ),
      { status: response.status },
    );
  if (!response?.ok)
    throw Object.assign(
      new Error(
        `Claude account data is temporarily unavailable${response ? ` (HTTP ${response.status})` : ""}. Try again.`,
      ),
      { status: response?.status },
    );
  return response.json();
}
// Subscription limits: the same data as the CLI's /usage view.
async function claudeUsage() {
  return claudeSubscriptionUsage(await claudeApi("/api/oauth/usage"));
}
// Exact models available to the account, plus the CLI's aliases. Falls back
// to the built-in list when the account's model list cannot be read.
async function claudeModels() {
  const aliases = [
    { id: "opus", displayName: "Opus · always latest" },
    { id: "sonnet", displayName: "Sonnet · always latest" },
    { id: "haiku", displayName: "Haiku · always latest" },
  ];
  try {
    const list: any = await claudeApi("/v1/models?limit=100", {
      "anthropic-version": "2023-06-01",
    });
    const exact = (Array.isArray(list?.data) ? list.data : [])
      .filter(
        (m: any) => typeof m?.id === "string" && m.id.startsWith("claude"),
      )
      .map((m: any) => ({
        id: m.id,
        model: m.id,
        displayName: m.display_name || m.id,
      }));
    if (exact.length) return [...exact, ...aliases];
  } catch {}
  return [...CLAUDE_FALLBACK_MODELS, ...aliases];
}
const CLAUDE_FALLBACK_MODELS = [
  {
    id: "claude-opus-5-5",
    model: "claude-opus-5-5",
    displayName: "Claude Opus 5.5",
  },
  {
    id: "claude-sonnet-5-5",
    model: "claude-sonnet-5-5",
    displayName: "Claude Sonnet 5.5",
  },
  {
    id: "claude-haiku-5-5",
    model: "claude-haiku-5-5",
    displayName: "Claude Haiku 5.5",
  },
];
createInterface({ input: process.stdin }).on("line", async (line) => {
  try {
    const c = JSON.parse(line) as RunnerCommand;
    if (c.type === "start") {
      ended = false;
      compacting = false;
      await mkdir("/profile/.codex", { recursive: true });
      await mkdir("/profile/.claude", { recursive: true });
      const githubSyncPort = c.input.githubSync
        ? await githubSync.start()
        : undefined;
      // Stop can arrive while the runner is processing buffered startup input.
      if (ended) return;
      if (c.input.provider === "codex") await runCodex(c.input, githubSyncPort);
      else await runClaude(c.input, githubSyncPort);
    }
    if (c.type === "github_sync_result")
      githubSync.reply(c.id, c.message, c.ok);
    if (c.type === "approve") {
      const mcpId = mcpApprovals.get(c.id);
      if (mcpId !== undefined) {
        send({
          id: mcpId,
          result: {
            action: c.allow ? "accept" : "decline",
            content: c.allow ? {} : null,
            _meta: null,
          },
        });
        mcpApprovals.delete(c.id);
      }
      const rid = rpcApprovals.get(c.id);
      if (rid !== undefined) {
        send({ id: rid, result: { decision: c.allow ? "accept" : "decline" } });
        rpcApprovals.delete(c.id);
      }
      approvals.get(c.id)?.(c.allow);
      approvals.delete(c.id);
    }
    if (c.type === "answer") {
      const rid = rpcQuestions.get(c.id);
      if (rid !== undefined) {
        send({ id: rid, result: { answers: c.answers } });
        rpcQuestions.delete(c.id);
      }
      questionAnswers.get(c.id)?.(c.answers);
      questionAnswers.delete(c.id);
    }
    if (c.type === "stop") {
      if (threadId) await rpc("turn/interrupt", { threadId }).catch(() => {});
      child?.kill("SIGTERM");
      terminal?.kill();
      finish("interrupted");
    }
    if (c.type === "auth") await auth(c.provider);
    if (c.type === "logout") {
      await mkdir("/profile/.codex", { recursive: true });
      await mkdir("/profile/.claude", { recursive: true });
      const logout = spawn(
        c.provider === "codex" ? "codex" : "claude",
        c.provider === "codex"
          ? ["logout", "-c", 'cli_auth_credentials_store="file"']
          : ["auth", "logout"],
        { stdio: "ignore", timeout: 25000 },
      );
      logout.on("error", () =>
        emit({ type: "logout_complete", success: false }),
      );
      logout.on("close", (code) =>
        emit({ type: "logout_complete", success: code === 0 }),
      );
    }
    if (c.type === "auth_input") terminal?.write(c.data);
    if (c.type === "usage") {
      if (c.provider !== "codex") {
        try {
          emit({ type: "limits_read", limits: await claudeUsage() });
        } catch (e: any) {
          emit({ type: "limits_error", error: e.message });
        }
        return;
      }
      await codex();
      emit({
        type: "limits_read",
        limits: await rpc("account/rateLimits/read", {}),
      });
    }
    if (c.type === "models") {
      if (c.provider === "codex") {
        await codex();
        emit({ type: "models", models: (await rpc("model/list", {})).data });
      } else emit({ type: "models", models: await claudeModels() });
    }
    if (c.type === "terminal") {
      if (!terminal) {
        const pty = await import("node-pty");
        const projectToolPath = process.env.WORKSPACE_PROJECT_TOOL_PATH;
        terminal = pty.spawn("/bin/bash", ["--noprofile", "--norc"], {
          name: "xterm-256color",
          cwd: "/workspace",
          cols: 100,
          rows: 30,
          env: {
            PATH: process.env.PATH,
            HOME: "/tmp",
            TERM: "xterm-256color",
            // Keep the terminal environment explicit, even inside a runner.
            ...(Object.fromEntries(
              Object.entries(process.env).filter(
                ([key, value]) =>
                  value !== undefined &&
                  (key.startsWith("AWS_") ||
                    (!!projectToolPath &&
                      (key === "WORKSPACE_PROJECT_TOOL_PATH" ||
                        Object.hasOwn(projectToolEnvironment, key)))),
              ),
            ) as Record<string, string>),
          },
        });
        terminal.onData((data: string) => emit({ type: "terminal", data }));
        terminal.onExit(() => {
          emit({ type: "terminal_closed" });
          terminal = undefined;
        });
      }
      terminal.write(c.data);
    }
    if (c.type === "resize")
      terminal?.resize(
        Math.max(10, Math.min(300, c.cols)),
        Math.max(5, Math.min(100, c.rows)),
      );
  } catch (e: any) {
    finish("failed", { error: e.message });
  }
});
