import type { ConversationRow, SessionPhase, TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import type {
  BuildConversationTurnRenderUnitsOptions,
  ConversationTurnRenderUnit,
} from "./conversationTurnRenderUnits.js";

interface TurnInput {
  turnId: string;
  header?: TurnHeaderRow;
  orderedRows: readonly ConversationRow[];
}

interface CachedTurn {
  header: TurnHeaderRow | undefined;
  rows: readonly ConversationRow[];
  sessionPhase: SessionPhase | undefined;
  nowMs: number | undefined;
  unit: ConversationTurnRenderUnit;
}

/** Timeline 实例级派生缓存；不拥有会话事实，丢失缓存只会重新计算。 */
export class ConversationTurnRenderUnitCache {
  private readonly turns = new Map<string, CachedTurn>();

  materialize(
    input: TurnInput,
    options: BuildConversationTurnRenderUnitsOptions,
    isRunning: boolean,
    create: () => ConversationTurnRenderUnit,
  ): ConversationTurnRenderUnit {
    const previous = this.turns.get(input.turnId);
    const nowMs = isRunning ? options.nowMs : undefined;
    if (
      previous &&
      previous.header === input.header &&
      previous.sessionPhase === options.sessionPhase &&
      previous.nowMs === nowMs &&
      previous.rows.length === input.orderedRows.length &&
      previous.rows.every((row, index) => row === input.orderedRows[index])
    ) {
      return previous.unit;
    }
    const unit = create();
    this.turns.set(input.turnId, {
      header: input.header,
      rows: input.orderedRows,
      sessionPhase: options.sessionPhase,
      nowMs,
      unit,
    });
    return unit;
  }

  finishBuild(units: readonly ConversationTurnRenderUnit[]): void {
    const retained = new Set<string>();
    for (const unit of units) {
      retained.add(unit.turnId);
      const entry = this.turns.get(unit.turnId);
      // 位置归一化可能生成新对象；保留最终对象，让下次命中的历史回合引用也稳定。
      if (entry) entry.unit = unit;
    }
    for (const turnId of this.turns.keys()) {
      if (!retained.has(turnId)) this.turns.delete(turnId);
    }
  }
}
