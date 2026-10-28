/** Pure AQ answer validation and wire-result construction. */
import type { NekAskQuestionPayload, NekAskQuestionResult } from "@zcode/shared/nek-protocol";

export interface AskQuestionDraft {
  questionId: string;
  selected: readonly string[];
  other: string;
}

export interface AskQuestionValidation {
  valid: boolean;
  questionId?: string;
  message?: string;
}

function invalid(questionId: string | undefined, message: string): AskQuestionValidation {
  return { valid: false, ...(questionId ? { questionId } : {}), message };
}

/** Validate one draft for every question; empty answers are always invalid. */
export function validateAskQuestionAnswers(
  payload: NekAskQuestionPayload,
  drafts: readonly AskQuestionDraft[],
): AskQuestionValidation {
  if (drafts.length !== payload.questions.length) {
    return invalid(undefined, "Every question needs an answer.");
  }
  const seenQuestions = new Set<string>();
  for (const draft of drafts) {
    const question = payload.questions.find((item) => item.id === draft.questionId);
    if (!question) return invalid(draft.questionId, "Unknown question.");
    if (seenQuestions.has(draft.questionId)) {
      return invalid(draft.questionId, "A question was answered more than once.");
    }
    seenQuestions.add(draft.questionId);

    const selected = [...draft.selected];
    const optionIds = new Set(question.options.map((option) => option.id));
    if (new Set(selected).size !== selected.length) {
      return invalid(draft.questionId, "An option was selected more than once.");
    }
    if (selected.some((id) => !optionIds.has(id))) {
      return invalid(draft.questionId, "An option is no longer available.");
    }
    if (!question.allow_multiple && selected.length > 1) {
      return invalid(draft.questionId, "Select one option only.");
    }
    const other = draft.other.trim();
    if (!question.allow_multiple && selected.length > 0 && other) {
      return invalid(draft.questionId, "An option and Other cannot be selected together.");
    }
    if (selected.length === 0 && !other) {
      return invalid(draft.questionId, "Select an option or enter a value for Other.");
    }
  }

  for (const question of payload.questions) {
    if (!seenQuestions.has(question.id)) {
      return invalid(question.id, "Every question needs an answer.");
    }
  }
  return { valid: true };
}

/** Build the protocol result in payload order, trimming and omitting empty Other values. */
export function buildAskQuestionResult(
  payload: NekAskQuestionPayload,
  drafts: readonly AskQuestionDraft[],
): NekAskQuestionResult {
  const validation = validateAskQuestionAnswers(payload, drafts);
  if (!validation.valid) {
    throw new Error(validation.message ?? "Invalid ask_question answer.");
  }
  return {
    answers: payload.questions.map((question) => {
      const draft = drafts.find((item) => item.questionId === question.id);
      if (!draft) throw new Error(`Missing answer for ${question.id}.`);
      const selected = question.options
        .filter((option) => draft.selected.includes(option.id))
        .map((option) => option.id);
      const other = draft.other.trim();
      return {
        questionId: question.id,
        selected,
        ...(other ? { other } : {}),
      };
    }),
  };
}
