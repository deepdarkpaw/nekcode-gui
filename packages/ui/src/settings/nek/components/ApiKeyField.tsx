/**
 * API Key 字段：默认掩码、可切换显示、粘贴时去掉空白；可改为读环境变量（写成 `$NAME`）。
 * 已保存的字面量不回显明文：留空即保持原值，占位符显示掩码。
 */
import type { ClipboardEvent } from "react";
import { useState } from "react";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";
import { sanitizePastedApiKey, type ApiKeyDraft, type ApiKeyMode } from "../lib/apiKey.js";
import { Segmented } from "./inputs.js";

export function ApiKeyField({
  id,
  draft,
  onChange,
  maskedExisting,
  invalid,
  placeholder,
}: {
  id: string;
  draft: ApiKeyDraft;
  onChange: (draft: ApiKeyDraft) => void;
  /** 已保存字面量的掩码（如 `••••1234`）。 */
  maskedExisting?: string;
  invalid?: boolean;
  placeholder?: string;
}) {
  const { intl } = useZCodeIntl();
  const [visible, setVisible] = useState(false);
  const modes: Array<{ value: ApiKeyMode; label: string }> = [
    { value: "literal", label: intl.formatMessage({ id: "settings.nek.apiKey.mode.literal" }) },
    { value: "env", label: intl.formatMessage({ id: "settings.nek.apiKey.mode.env" }) },
  ];
  if (draft.mode === "command") {
    modes.push({
      value: "command",
      label: intl.formatMessage({ id: "settings.nek.apiKey.mode.command" }),
    });
  }

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    if (draft.mode !== "literal") {
      return;
    }
    const text = event.clipboardData.getData("text");
    const cleaned = sanitizePastedApiKey(text);
    if (cleaned === text) {
      return;
    }
    event.preventDefault();
    const input = event.currentTarget;
    const start = input.selectionStart ?? draft.value.length;
    const end = input.selectionEnd ?? draft.value.length;
    onChange({ ...draft, value: draft.value.slice(0, start) + cleaned + draft.value.slice(end) });
  };

  const literalPlaceholder =
    draft.keepExisting && maskedExisting
      ? intl.formatMessage(
          { id: "settings.nek.apiKey.keepPlaceholder" },
          { masked: maskedExisting },
        )
      : placeholder;

  return (
    <div className="flex flex-col gap-1.5">
      <Segmented
        ariaLabel={intl.formatMessage({ id: "settings.nek.apiKey.modeLabel" })}
        value={draft.mode}
        options={modes}
        onChange={(mode) =>
          onChange({ mode, value: "", keepExisting: mode === "literal" && draft.keepExisting })
        }
      />
      {draft.mode === "env" ? (
        <div className="flex items-center gap-1">
          <span className="font-mono text-ui-base text-foreground-subtle">$</span>
          <Input
            {...TECHNICAL_INPUT_ATTRIBUTES}
            id={id}
            value={draft.value.replace(/^\$/, "")}
            aria-invalid={invalid || undefined}
            placeholder="OPENAI_API_KEY"
            className="font-mono"
            onChange={(event) => onChange({ ...draft, value: event.target.value })}
          />
        </div>
      ) : (
        <div className="relative">
          <Input
            {...TECHNICAL_INPUT_ATTRIBUTES}
            id={id}
            type={visible || draft.mode === "command" ? "text" : "password"}
            value={draft.value}
            aria-invalid={invalid || undefined}
            placeholder={draft.mode === "command" ? "!op read op://vault/key" : literalPlaceholder}
            className="pr-9 font-mono"
            onPaste={handlePaste}
            onChange={(event) => onChange({ ...draft, value: event.target.value })}
          />
          {draft.mode === "literal" ? (
            <IconButton
              size="icon-sm"
              type="button"
              className="absolute top-1/2 right-1 -translate-y-1/2"
              label={intl.formatMessage({
                id: visible ? "settings.nek.apiKey.hide" : "settings.nek.apiKey.show",
              })}
              aria-pressed={visible}
              onClick={() => setVisible((current) => !current)}
            >
              {visible ? <EyeOffIcon /> : <EyeIcon />}
            </IconButton>
          ) : null}
        </div>
      )}
    </div>
  );
}
