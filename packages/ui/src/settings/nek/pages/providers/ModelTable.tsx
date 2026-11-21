/**
 * 模型表格：ID（等宽）、显示名称、上下文、最大输出、思考等级徽标、图片输入；
 * 拖拽排序、CLI 循环范围；行内操作：编辑、设为默认、删除（带撤销）。
 */
import type { ReactNode } from "react";
import { ImageIcon, PencilIcon, StarIcon, Trash2Icon } from "lucide-react";
import type { NekModelConfig, NekProviderView } from "@zcode/shared/nek-protocol";
import { nekThinkingLevelsFromMap } from "@zcode/shared/nek-protocol";
import { AsyncButton } from "@/components/ui/async-button.js";
import { IconButton } from "@/components/ui/icon-button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatTokens } from "@/lib/displayFormat.js";
import { ThinkingLevelBadges } from "../../components/modelControls.js";
import { SortableList } from "../../components/SortableList.js";
import { useCliModelScope } from "../../api/useCliModelScope.js";
import { ModelScopeCheckbox, ModelScopeSaveFeedback } from "../../components/ModelScopeControls.js";
import { formatModelRef } from "../../lib/modelRef.js";

const GRID =
  "grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_4rem_4rem_minmax(0,1.4fr)_1.5rem_4rem_5.5rem] items-center gap-2";

export function modelThinkingLevels(model: NekModelConfig) {
  if (!model.reasoning) {
    return [];
  }
  return nekThinkingLevelsFromMap(model.thinkingLevelMap);
}

function ModelRowView({
  model,
  isDefault,
  scopeCheckbox,
  onEdit,
  onSetDefault,
  onDelete,
}: {
  model: NekModelConfig;
  isDefault: boolean;
  scopeCheckbox: ReactNode;
  onEdit: () => void;
  onSetDefault: () => void;
  onDelete: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className={cn(GRID, "py-1.5 pr-1 text-ui-sm")}>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate font-mono text-foreground" title={model.id}>
          {model.id}
        </span>
        {isDefault ? (
          <span className="shrink-0 rounded-sm bg-accent px-1 text-ui-xs leading-5 text-foreground">
            {intl.formatMessage({ id: "settings.nek.model.defaultBadge" })}
          </span>
        ) : null}
      </span>
      <span className="truncate text-foreground-subtle">{model.name ?? "—"}</span>
      <span className="font-mono text-foreground-subtle">
        {model.contextWindow ? formatTokens(model.contextWindow) : "—"}
      </span>
      <span className="font-mono text-foreground-subtle">
        {model.maxTokens ? formatTokens(model.maxTokens) : "—"}
      </span>
      <ThinkingLevelBadges levels={modelThinkingLevels(model)} />
      <span>
        {model.input?.includes("image") ? (
          <ImageIcon
            className="size-3.5 text-foreground-subtle"
            aria-label={intl.formatMessage({ id: "settings.nek.model.imageInput" })}
          />
        ) : null}
      </span>
      <span className="flex justify-center">{scopeCheckbox}</span>
      <span className="flex justify-end gap-0.5">
        <IconButton
          size="icon-sm"
          label={intl.formatMessage({ id: "settings.nek.model.edit" })}
          onClick={onEdit}
        >
          <PencilIcon />
        </IconButton>
        <IconButton
          size="icon-sm"
          label={intl.formatMessage({
            id: isDefault ? "settings.nek.model.isDefault" : "settings.nek.model.setDefault",
          })}
          disabled={isDefault}
          disabledReason={intl.formatMessage({ id: "settings.nek.model.isDefault" })}
          onClick={onSetDefault}
        >
          <StarIcon className={isDefault ? "fill-current" : undefined} />
        </IconButton>
        <IconButton
          size="icon-sm"
          label={intl.formatMessage({ id: "settings.nek.model.delete" })}
          onClick={onDelete}
        >
          <Trash2Icon />
        </IconButton>
      </span>
    </div>
  );
}

export function ModelTable({
  provider,
  defaultModelId,
  onEdit,
  onSetDefault,
  onDelete,
  onReorder,
}: {
  provider: NekProviderView;
  defaultModelId: string | undefined;
  onEdit: (model: NekModelConfig) => void;
  onSetDefault: (model: NekModelConfig) => void;
  onDelete: (model: NekModelConfig) => void;
  onReorder: (ids: string[]) => void;
}) {
  const { intl } = useZCodeIntl();
  const byId = new Map(provider.models.map((model) => [model.id, model]));
  const scope = useCliModelScope();
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 text-ui-sm text-foreground-subtle">
        {scope.query.status === "error" ? (
          <>
            <span role="alert" className="min-w-0 break-words text-destructive">
              {scope.query.error?.message}
            </span>
            <AsyncButton
              size="xs"
              variant="ghost"
              onClick={scope.query.reload}
              successFeedback="none"
            >
              {intl.formatMessage({ id: "settings.nek.load.retry" })}
            </AsyncButton>
          </>
        ) : (
          <span>{intl.formatMessage({ id: "settings.nek.scoped.exclusionHint" })}</span>
        )}
        <ModelScopeSaveFeedback editor={scope} />
      </div>
      <div
        className={cn(
          GRID,
          "border-b border-border py-1.5 pl-7 pr-1 text-ui-xs text-foreground-subtlest",
        )}
        aria-hidden="true"
      >
        <span>{intl.formatMessage({ id: "settings.nek.model.col.id" })}</span>
        <span>{intl.formatMessage({ id: "settings.nek.model.col.name" })}</span>
        <span>{intl.formatMessage({ id: "settings.nek.model.col.context" })}</span>
        <span>{intl.formatMessage({ id: "settings.nek.model.col.maxTokens" })}</span>
        <span>{intl.formatMessage({ id: "settings.nek.model.col.thinking" })}</span>
        <span />
        <span className="text-center">
          {intl.formatMessage({ id: "settings.nek.scoped.column" })}
        </span>
        <span />
      </div>
      <SortableList
        ids={provider.models.map((model) => model.id)}
        dragLabel={intl.formatMessage({ id: "settings.nek.model.dragLabel" })}
        onReorder={onReorder}
        renderItem={(id) => {
          const model = byId.get(id);
          return model ? (
            <ModelRowView
              model={model}
              isDefault={defaultModelId === model.id}
              scopeCheckbox={
                <ModelScopeCheckbox
                  editor={scope}
                  modelRef={formatModelRef(provider.id, model.id)}
                />
              }
              onEdit={() => onEdit(model)}
              onSetDefault={() => onSetDefault(model)}
              onDelete={() => onDelete(model)}
            />
          ) : null;
        }}
      />
    </div>
  );
}
