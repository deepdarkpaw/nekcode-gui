import { memo } from "react";
import { ChevronDownIcon } from "lucide-react";
import {
  TID_CHAT_MODE_SELECT_TRIGGER,
  TID_CHAT_MODE_SELECT_ITEM,
  TID_V4_COMPOSER_INPUT,
  ZCODE_AGENT_PROVIDER,
  getZCodeAgentAvailableModes,
  testId,
} from "@zcode/shared";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import {
  getModeOptionDisplayLabel,
  getModeOptionDescriptionMessageId,
  resolveModeOptionIcon,
} from "@/chat-input-toolbar/display.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isCoarseTouchDevice } from "@/lib/pickerFocus.js";
import { useActionShortcutLabel } from "@/shortcuts/useActionShortcuts.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import type { V4ComposerToolbarProps } from "@/v4/composer/V4ComposerToolbar.js";

/** 模式只有 agent / plan 两档，单选；只编辑草稿，不向 Runtime 发切换命令。 */
function V4ComposerModeSwitchImpl({
  provider,
  draftConfig,
  disabled,
  activeConfigPicker,
  onConfigPickerOpenChange,
  onSwitchMode,
}: Pick<
  V4ComposerToolbarProps,
  | "workspacePath"
  | "workspaceIdentity"
  | "provider"
  | "draftConfig"
  | "disabled"
  | "activeConfigPicker"
  | "onConfigPickerOpenChange"
  | "onSwitchMode"
>) {
  const { intl } = useZCodeIntl();
  const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
  // Agent/Plan 切换的快捷键是 nek 动作 `nek.plan.toggle`（默认 Alt+M），
  // 由 SessionPane 统一登记；工具条只负责展示 label 与点击切换。
  const modeShortcutLabel = useActionShortcutLabel("nek.plan.toggle");
  const modes = getZCodeAgentAvailableModes();
  const selected = modes.find((mode) => mode.id === draftConfig?.mode);
  const label = (mode: (typeof modes)[number]) =>
    getModeOptionDisplayLabel(intl, displayProvider, { value: mode.id, name: mode.name });
  if (!selected) return null;
  const Icon = resolveModeOptionIcon(selected.id);
  return (
    <div className="flex min-w-0 items-center gap-1">
      <DropdownMenu
        open={activeConfigPicker === "mode"}
        onOpenChange={(open) => onConfigPickerOpenChange("mode", open)}
      >
        <ControlHintTooltip
          title={intl.formatMessage({ id: "chat.toolbar.mode.label" })}
          shortcut={modeShortcutLabel}
          open={activeConfigPicker === "mode" ? false : undefined}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              data-testid={TID_CHAT_MODE_SELECT_TRIGGER}
              data-composer-collapse-priority="1"
              aria-label={intl.formatMessage({ id: "chat.toolbar.mode.label" })}
              className={cn(
                "group/mode h-7 gap-1 rounded-lg px-2 text-ui-base data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0",
              )}
            >
              <Icon className="size-4" />
              <span className="inline group-data-[composer-compact=true]/mode:hidden">
                {label(selected)}
              </span>
              <ChevronDownIcon className="size-3.5 group-data-[composer-compact=true]/mode:hidden" />
            </Button>
          </DropdownMenuTrigger>
        </ControlHintTooltip>
        <DropdownMenuContent
          side="top"
          sideOffset={4}
          className="w-64"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!isCoarseTouchDevice())
              document
                .querySelector<HTMLElement>(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`)
                ?.focus();
          }}
        >
          <DropdownMenuRadioGroup value={selected.id} onValueChange={onSwitchMode}>
            {modes.map((mode) => {
              const ModeIcon = resolveModeOptionIcon(mode.id);
              const descriptionId = getModeOptionDescriptionMessageId(displayProvider, {
                value: mode.id,
              });
              return (
                <DropdownMenuRadioItem
                  key={mode.id}
                  value={mode.id}
                  data-testid={testId(TID_CHAT_MODE_SELECT_ITEM, mode.id)}
                  className="min-h-13 items-start gap-3 py-2"
                >
                  <ModeIcon className="mt-0.5 size-4.5 shrink-0" />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span>{label(mode)}</span>
                    {descriptionId && (
                      <span className="text-ui-sm text-foreground-subtle">
                        {intl.formatMessage({ id: descriptionId })}
                      </span>
                    )}
                  </span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
export const V4ComposerModeSwitch = memo(V4ComposerModeSwitchImpl);
