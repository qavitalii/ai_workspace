import { describe, expect, it } from "vitest";
import {
  buildQuestionAnswers,
  emptyQuestionDraft,
  questionAnswers,
  type AgentQuestion,
} from "../src/question-answers";
const question: AgentQuestion = {
  id: "choice",
  question: "Choose?",
  options: [{ label: "First" }, { label: "Second" }],
};
describe("agent question answers", () => {
  it("requires an explicit choice", () => {
    expect(questionAnswers(question)).toBeNull();
    expect(questionAnswers(question, emptyQuestionDraft())).toBeNull();
  });
  it("sends a single option or a custom replacement, never both", () => {
    expect(
      questionAnswers(question, {
        selected: ["First"],
        custom: false,
        text: "old draft",
      }),
    ).toEqual(["First"]);
    expect(
      questionAnswers(question, {
        selected: ["First"],
        custom: true,
        text: "  Own answer  ",
      }),
    ).toEqual(["Own answer"]);
    expect(
      questionAnswers(question, {
        selected: ["First", "Second"],
        custom: false,
        text: "",
      }),
    ).toBeNull();
  });
  it("sends multiple choices as separate values in option order", () => {
    expect(
      questionAnswers(
        { ...question, multiSelect: true },
        {
          selected: ["Second", "First"],
          custom: true,
          text: "Additional choice",
        },
      ),
    ).toEqual(["First", "Second", "Additional choice"]);
  });
  it("ignores deselected custom text and unknown options", () => {
    expect(
      questionAnswers(
        { ...question, multiSelect: true },
        { selected: ["Second", "Unknown"], custom: false, text: "Hidden text" },
      ),
    ).toEqual(["Second"]);
  });
  it("does not submit an empty custom choice alongside valid selections", () => {
    expect(
      questionAnswers(
        { ...question, multiSelect: true },
        { selected: ["First"], custom: true, text: "  " },
      ),
    ).toBeNull();
  });
  it("handles free text, secret values and disabled custom choices", () => {
    expect(
      questionAnswers(
        { ...question, options: null },
        { selected: [], custom: false, text: "Answer" },
      ),
    ).toEqual(["Answer"]);
    expect(
      questionAnswers(
        { ...question, isSecret: true },
        { selected: ["First"], custom: false, text: "synthetic-secret" },
      ),
    ).toEqual(["synthetic-secret"]);
    expect(
      questionAnswers(
        { ...question, isOther: false },
        { selected: ["First"], custom: true, text: "ignored" },
      ),
    ).toEqual(["First"]);
  });
  it("requires all question IDs and preserves the agent response format", () => {
    const questions = [
      question,
      {
        id: "scope",
        question: "Scope?",
        multiSelect: true,
        options: question.options,
      },
    ];
    const drafts = {
      choice: { selected: ["Second"], custom: false, text: "" },
      scope: { selected: ["First", "Second"], custom: false, text: "" },
    };
    expect(
      buildQuestionAnswers(questions, { choice: drafts.choice }),
    ).toBeNull();
    expect(buildQuestionAnswers(questions, drafts)).toEqual({
      choice: { answers: ["Second"] },
      scope: { answers: ["First", "Second"] },
    });
    expect(buildQuestionAnswers([], {})).toBeNull();
    expect(buildQuestionAnswers([question, question], drafts)).toBeNull();
  });
  it("enforces API limits and deduplicates labels", () => {
    expect(
      questionAnswers(question, {
        selected: [],
        custom: true,
        text: "x".repeat(10001),
      }),
    ).toBeNull();
    const many = Array.from({ length: 21 }, (_, i) => ({ label: String(i) }));
    expect(
      questionAnswers(
        { ...question, multiSelect: true, options: many },
        { selected: many.map((o) => o.label), custom: false, text: "" },
      ),
    ).toBeNull();
    expect(
      questionAnswers(
        { ...question, multiSelect: true },
        { selected: ["First"], custom: true, text: "First" },
      ),
    ).toEqual(["First"]);
  });
});
