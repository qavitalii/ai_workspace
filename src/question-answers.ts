export type AgentQuestion = {
  id: string;
  header?: string;
  question: string;
  options?: { label: string; description?: string }[] | null;
  multiSelect?: boolean;
  isSecret?: boolean;
  isOther?: boolean;
};
export type QuestionDraft = {
  selected: string[];
  custom: boolean;
  text: string;
};
export const emptyQuestionDraft = (): QuestionDraft => ({
  selected: [],
  custom: false,
  text: "",
});

export function questionAnswers(
  question: AgentQuestion,
  draft?: QuestionDraft,
): string[] | null {
  if (!draft) return null;
  const options = question.isSecret ? [] : question.options || [];
  const custom =
    !options.length || (question.isOther !== false && draft.custom);
  const selected = options
    .filter((o) => draft.selected.includes(o.label))
    .map((o) => o.label);
  const text = draft.text.trim();
  if (custom && (!text || text.length > 10000)) return null;
  const answers =
    custom && !question.multiSelect
      ? [text]
      : [...selected, ...(custom ? [text] : [])];
  const unique = [...new Set(answers)];
  if (
    !unique.length ||
    unique.length > 20 ||
    (!question.multiSelect && unique.length > 1) ||
    unique.some((a) => !a.trim() || a.length > 10000)
  )
    return null;
  return unique;
}

export function buildQuestionAnswers(
  questions: AgentQuestion[],
  drafts: Record<string, QuestionDraft>,
): Record<string, { answers: string[] }> | null {
  if (
    !questions.length ||
    new Set(questions.map((q) => q.id)).size !== questions.length
  )
    return null;
  const entries = questions.map(
    (q) => [q.id, questionAnswers(q, drafts[q.id])] as const,
  );
  if (entries.some(([, answers]) => !answers)) return null;
  return Object.fromEntries(
    entries.map(([id, answers]) => [id, { answers: answers! }]),
  );
}
