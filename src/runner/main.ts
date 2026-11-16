import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { quotaError, type RunInput, type RunnerCommand } from "../shared.js";
const emit = (data: unknown) =>
  process.stdout.write(JSON.stringify(data) + "\n");
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
  emit({ type, ...extra });
}
function processChild(
  command: string,
  args: string[],
  onLine: (line: string) => void,
) {
  child = spawn(command, args, {
    cwd: "/workspace",
    env: {
      ...process.env,
      HOME: "/profile",
      CODEX_HOME: "/profile/.codex",
      CLAUDE_CONFIG_DIR: "/profile/.claude",
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
async function codex() {
  await mkdir("/profile/.codex", { recursive: true });
  processChild(
    "codex",
    [
      "app-server",
      "--listen",
      "stdio://",
      "-c",
      'cli_auth_credentials_store="file"',
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
      if (m.method === "item/completed")
        emit({ type: "checkpoint", item: p.item });
      if (m.method === "item/started" && p.item?.type !== "agentMessage")
        emit({ type: "tool", item: p.item });
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
async function runCodex(input: RunInput) {
  await codex();
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
  const prompt: any[] = [{ type: "text", text: input.prompt }];
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
async function runClaude(input: RunInput) {
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
        emit({
          type: "approval",
          id,
          description:
            p.tool_name === "ExitPlanMode"
              ? "Allow Claude to leave planning mode and implement the plan in this run?"
              : p.tool_name || "Allow this action?",
          details: p.input,
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
  if (input.model) args.push("--model", input.model);
  if (input.effort) args.push("--effort", input.effort);
  if (input.autonomous && input.mode !== "plan")
    args.push("--dangerously-skip-permissions");
  else
    args.push(
      "--permission-mode",
      input.mode === "plan" ? "plan" : "default",
      "--mcp-config",
      JSON.stringify({
        mcpServers: {
          workspace_permissions: {
            command: "node",
            args: ["/app/dist/node/runner/permissions.js"],
          },
        },
      }),
      "--permission-prompt-tool",
      "mcp__workspace_permissions__approve",
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
  const content: any[] = [{ type: "text", text: input.prompt }];
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
createInterface({ input: process.stdin }).on("line", async (line) => {
  try {
    const c = JSON.parse(line) as RunnerCommand;
    if (c.type === "start") {
      ended = false;
      compacting = false;
      await mkdir("/profile/.codex", { recursive: true });
      await mkdir("/profile/.claude", { recursive: true });
      if (c.input.provider === "codex") await runCodex(c.input);
      else await runClaude(c.input);
    }
    if (c.type === "approve") {
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
    if (c.type === "models") {
      if (c.provider === "codex") {
        await codex();
        emit({ type: "models", models: (await rpc("model/list", {})).data });
      } else
        emit({
          type: "models",
          models: [
            { id: "sonnet", displayName: "Sonnet" },
            { id: "opus", displayName: "Opus" },
            { id: "haiku", displayName: "Haiku" },
          ],
        });
    }
    if (c.type === "terminal") {
      if (!terminal) {
        const pty = await import("node-pty");
        terminal = pty.spawn("/bin/bash", ["--noprofile", "--norc"], {
          name: "xterm-256color",
          cwd: "/workspace",
          cols: 100,
          rows: 30,
          env: { PATH: process.env.PATH, HOME: "/tmp", TERM: "xterm-256color" },
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
