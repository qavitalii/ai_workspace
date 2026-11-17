// Opt-in in-memory interaction fixtures. Never contact a provider or execute an action.
const enabled = process.env.PREVIEW_INTERACTIONS === "1";
const resolved = new Set();
const attempts = new Map();
const responses = new Map();
let refreshFailure = false;
const questions = {
  "demo-question": {
    id: "demo-question",
    kind: "question",
    questions: [
      {
        id: "layout",
        header: "Layout",
        question: "How should the new workspace look?",
        options: [
          {
            label: "Compact (Recommended)",
            description:
              "Smaller spacing and clear controls, consistent with the rest of the app.",
          },
          {
            label: "Comfortable",
            description:
              "More room between items for a relaxed reading experience.",
          },
        ],
      },
      {
        id: "areas",
        header: "Scope",
        question: "Which areas should I update?",
        multiSelect: true,
        options: [
          {
            label: "Chat and composer",
            description: "Messages, attachments and the input toolbar.",
          },
          {
            label: "File browser",
            description: "Folder navigation and file previews.",
          },
          {
            label: "Settings",
            description: "Account and workspace preferences.",
          },
        ],
      },
    ],
  },
  "demo-text-question": {
    id: "demo-text-question",
    kind: "question",
    questions: [
      { id: "notes", header: "Notes", question: "What should I keep in mind?" },
      {
        id: "secret",
        header: "Private answer",
        question: "Enter the test access phrase",
        isSecret: true,
      },
    ],
  },
  "demo-permission": {
    id: "demo-permission",
    kind: "permission",
    description: "Run the project’s test suite",
    details: {
      command: "npm test",
      cwd: "/workspace/studio-website",
      reason: "Check that the interface changes preserve existing behavior.",
    },
  },
  "demo-no-details": {
    id: "demo-no-details",
    kind: "permission",
    description: "Update workspace files",
    details: null,
  },
};
export function previewApprovals(chatId) {
  if (!enabled) return [];
  const ids =
    chatId === "demo-chat"
      ? [resolved.has("demo-question") ? "demo-permission" : "demo-question"]
      : chatId === "demo-review"
        ? ["demo-text-question"]
        : chatId === "demo-notes"
          ? ["demo-no-details"]
          : [];
  return ids.filter((id) => !resolved.has(id)).map((id) => questions[id]);
}
export function previewResponses(chatId) {
  return enabled ? responses.get(chatId) || [] : [];
}
export async function handlePreviewInteraction(req, res, path) {
  if (!enabled) return false;
  if (
    req.method === "GET" &&
    path === "/api/chats/demo-review" &&
    refreshFailure
  ) {
    refreshFailure = false;
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Simulated refresh failure" }));
    return true;
  }
  const match = path.match(
    /^\/api\/(questions|approvals)\/(demo-question|demo-text-question|demo-permission|demo-no-details)$/,
  );
  if (req.method !== "POST" || !match) return false;
  res.setHeader("Content-Type", "application/json");
  const id = match[2];
  if (resolved.has(id)) {
    res.statusCode = 409;
    res.end(JSON.stringify({ error: "This request is no longer active" }));
    return true;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  attempts.set(id, (attempts.get(id) || 0) + 1);
  if (id === "demo-question" && attempts.get(id) === 1) {
    res.statusCode = 503;
    res.end(
      JSON.stringify({
        error:
          "Simulated connection failure. Your choices are kept; try again.",
      }),
    );
    return true;
  }
  if (
    match[1] === "questions" &&
    questions[id].questions.some((q) => !body.answers?.[q.id]?.answers?.length)
  ) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "Answer every question." }));
    return true;
  }
  if (id === "demo-no-details" && body.allow) {
    res.statusCode = 409;
    res.end(JSON.stringify({ error: "Action details are unavailable." }));
    return true;
  }
  resolved.add(id);
  const chatId =
    id === "demo-text-question"
      ? "demo-review"
      : id === "demo-no-details"
        ? "demo-notes"
        : "demo-chat";
  const content =
    id === "demo-text-question"
      ? "Test answers received. Private values are not shown in the preview."
      : match[1] === "questions"
        ? "Preview received these answers:\n```json\n" +
          JSON.stringify(body.answers, null, 2) +
          "\n```"
        : body.allow
          ? "Preview: permission allowed. No commands were executed."
          : "Preview: permission denied. No commands were executed.";
  responses.set(chatId, [
    ...(responses.get(chatId) || []),
    {
      id: "reply-" + id,
      role: "assistant",
      content,
      created_at: new Date().toISOString(),
    },
  ]);
  if (id === "demo-text-question") refreshFailure = true;
  res.end(JSON.stringify({ ok: true }));
  return true;
}
