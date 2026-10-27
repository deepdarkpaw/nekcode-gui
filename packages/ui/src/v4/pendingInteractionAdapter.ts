import type { ZCodeElicitationRequest } from "@zcode/shared";
import type { PendingInteraction, UserInputRequestPayload } from "@zcode/shared/zcode-protocol-v4";

export interface V4UserInputViewModel {
  interactionId: string;
  prompt: string;
  freeText: boolean;
  sensitive?: boolean;
  options: ReadonlyArray<{ optionId: string; label: string }>;
}

export function pendingUserInputToViewModel(
  interaction: PendingInteraction & { payload: UserInputRequestPayload },
): V4UserInputViewModel {
  return {
    interactionId: interaction.interactionId,
    prompt: interaction.payload.prompt,
    freeText: interaction.payload.freeText,
    sensitive: interaction.payload.sensitive,
    options: interaction.payload.options ?? [],
  };
}

export function pendingUserInputToElicitationRequest(
  sessionId: string,
  interaction: PendingInteraction & { payload: UserInputRequestPayload },
): ZCodeElicitationRequest | null {
  const { payload } = interaction;
  if (!payload.questions || payload.questions.length === 0) {
    return null;
  }
  const firstQuestion = payload.questions[0];
  return {
    type: "elicitation_request",
    taskId: sessionId,
    traceId: payload.traceId ?? sessionId,
    requestId: interaction.interactionId,
    message: firstQuestion?.question ?? payload.prompt,
    header: firstQuestion?.header,
    options: firstQuestion?.options ?? [],
    ...(firstQuestion?.multiSelect ? { multiSelect: true } : {}),
    questions: payload.questions,
    ...(payload.currentQuestionIndex !== undefined
      ? { currentQuestionIndex: payload.currentQuestionIndex }
      : {}),
    ...(payload.answerDrafts ? { answerDrafts: payload.answerDrafts } : {}),
    ...(payload.origin ? { origin: payload.origin } : {}),
    schema: payload.schema ?? payload.input,
  };
}
