/**
 * 密钥类设置字段（如 Exa API Key）：默认掩码、可切换显示、粘贴去空白；
 * 与 SettingTextField 相同的提交规则：失焦 / Enter 提交，Esc 还原，未变化不提交；空值 = 删除。
 */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button.js";
import { Input } from "@/components/ui/input.js";
import { SettingRow } from "@/components/ui/setting-fields.js";
import { useAsyncAction } from "@/hooks/useAsyncAction.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isImeComposing } from "@/lib/imeComposition.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";
import { sanitizePastedApiKey } from "../lib/apiKey.js";

export function SecretSettingField({
  label,
  description,
  value,
  placeholder,
  onCommit,
}: {
  label: ReactNode;
  description?: ReactNode;
  value: string;
  placeholder?: string;
  onCommit: (value: string) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const id = useId();
  const [draft, setDraft] = useState(value);
  const [visible, setVisible] = useState(false);
  const dirtyRef = useRef(false);
  const action = useAsyncAction(onCommit);
  useEffect(() => {
    if (!dirtyRef.current) setDraft(value);
  }, [value]);

  const submit = () => {
    const next = draft.trim();
    if (next === value) {
      dirtyRef.current = false;
      return;
    }
    void action.run(next).then((ok) => {
      if (ok) dirtyRef.current = false;
    });
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(event)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dirtyRef.current = false;
      setDraft(value);
      action.reset();
    }
  };
  const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    const cleaned = sanitizePastedApiKey(text);
    if (cleaned !== text) {
      event.preventDefault();
      dirtyRef.current = true;
      setDraft(cleaned);
    }
  };
  return (
    <SettingRow label={label} description={description} htmlFor={id} state={action.state}>
      <div className="relative w-56">
        <Input
          {...TECHNICAL_INPUT_ATTRIBUTES}
          id={id}
          type={visible ? "text" : "password"}
          value={draft}
          placeholder={placeholder}
          aria-invalid={action.state.status === "error" || undefined}
          className="pr-8 font-mono"
          onChange={(event) => {
            dirtyRef.current = true;
            setDraft(event.target.value);
          }}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
          onBlur={submit}
        />
        <IconButton
          size="icon-sm"
          className="absolute top-1/2 right-0.5 -translate-y-1/2"
          label={intl.formatMessage({
            id: visible ? "settings.nek.apiKey.hide" : "settings.nek.apiKey.show",
          })}
          aria-pressed={visible}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </IconButton>
      </div>
    </SettingRow>
  );
}
