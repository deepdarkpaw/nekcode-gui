/** Pure answer and keyboard rules for the nek.ask_question structured interaction. */
import type {
  NekAskQuestionPayload,
  NekAskQuestionResult,
} from "@zcode/shared/nek-protocol";
import { isImeComposing } from "@/lib/imeComposition.js";

export interface AskQuestionDraft {
  questionId: string;
  selected: readonly string[];
  /** A non-empty value means that the user selected the Other option. */
  other?: string;
}

export interface AskQuestionValidation {
  valid: boolean;
  questionId?: string;
  message?: string;
}

export type AskQuestionKeyAction = "previous" | "next" | "toggle" | "submit" | "cancel";

/** Return the action owned by the form, or null when the browser/IME owns the key. */
export function resolveAskQuestionKeyAction(event: {
  key: string;
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}): AskQuestionKeyAction | null {
  if (isImeComposing(event)) return null;
  switch (event.key) {
    case "ArrowUp":
      return "previous";
    case "ArrowDown":
      return "next";
    case " ":
    case "Spacebar":
      return "toggle";
    case "Enter":
      return "submit";
    case "Escape":
      return "cancel";
    default:
      return null;
  }
}

function questionById(
  payload: NekAskQuestionPayload,
  questionId: string,
): NekAskQuestionPayload["questions"][number] | undefined {
  return payload.questions.find((question) => question.id === questionId);
}

function invalid(questionId: string | undefined, message: string): AskQuestionValidation {
  return { valid: false, ...(questionId ? { questionId } : {}), message };
}

/** Validate drafts before they are turned into the wire result. */
export function validateAskQuestionAnswers(
  payload: NekAskQuestionPayload,
  drafts: readonly AskQuestionDraft[],
): AskQuestionValidation {
  if (drafts.length !== payload.questions.length) {
    return invalid(undefined, "Every question needs an answer.");
  }

  const seenQuestions = new Set<string>();
  for (const draft of drafts) {
    const question = questionById(payload, draft.questionId);
    if (!question) return invalid(draft.questionId, "Unknown question.");
    if (seenQuestions.has(draft.questionId)) {
      return invalid(draft.questionId, "A question was answered more than once.");
    }
    seenQuestions.add(draft.questionId);

    const selected = [...draft.selected];
    if (new Set(selected).size !== selected.length) {
      return invalid(draft.questionId, "An option was selected more than once.");
    }
    const optionIds = new Set(question.options.map((option) => option.id));
    if (selected.some((id) => !optionIds.has(id))) {
      return invalid(draft.questionId, "An option is no longer available.");
    }
    if (!question.allow_multiple && selected.length > 1) {
      return invalid(draft.questionId, "Select one option only.");
    }

    const other = draft.other?.trim();
    if (draft.other !== undefined && !other) {
      return invalid(draft.questionId, "Enter a value for Other.");
    }
    if (!question.allow_multiple && selected.length === 0 && !other) {
      return invalid(draft.questionId, "Select an option.");
    }
  }

  for (const question of payload.questions) {
    if (!seenQuestions.has(question.id)) {
      return invalid(question.id, "Every question needs an answer.");
    }
  }
  return { valid: true };
}

/** Build the protocol result, preserving question and option order from the request. */
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
      const draft = drafts.find((candidate) => candidate.questionId === question.id);
      if (!draft) throw new Error(`Missing answer for ${question.id}.`);
      const selected = question.options
        .filter((option) => draft.selected.includes(option.id))
        .map((option) => option.id);
      const other = draft.other?.trim();
      return {
        questionId: question.id,
        selected,
        ...(other ? { other } : {}),
      };
    }),
  };
}
