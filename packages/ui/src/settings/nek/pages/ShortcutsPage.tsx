/**
 * 快捷键：基于 shortcuts/actionRegistry 列出全部动作；录制新按键（Esc 取消）、冲突检测、
 * 单项 / 全部恢复默认、导入 nek 的 keybindings.json（无法转换的条目明确告知）。
 */
import { useEffect, useState } from "react";
import { KeyboardIcon, RotateCcwIcon, UploadIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { IconButton } from "@/components/ui/icon-button.js";
import { Kbd, KbdGroup } from "@/components/ui/kbd.js";
import { SettingSection } from "@/components/ui/setting-fields.js";
import { Textarea } from "@/components/ui/textarea.js";
import { cn } from "@/components/lib/utils.js";
import { useFocusRestore } from "@/hooks/useFocusRestore.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";
import { formatActionBindingLabelParts } from "@/shortcuts/actionBinding.js";
import { setShortcutRecordingActive } from "@/shortcuts/bindings.js";
import {
  checkActionBindingConflict,
  findActionConflicts,
  importNekKeybindings,
  resolveEffectiveActionBindings,
  type ActionShortcutOverrides,
} from "@/shortcuts/actionRegistry.js";
import {
  NEK_ACTIONS,
  nekActionLabelId,
  type NekActionCategory,
  type NekActionId,
} from "@/shortcuts/nekActions.js";
import { recordActionBinding } from "../lib/actionRecording.js";
import { useNekGuiPreferences } from "../gui/guiPreferences.js";
import { NekPageFrame } from "../components/NekPageFrame.js";
import { handleRowArrowNavigation } from "../components/SortableList.js";

const CATEGORIES: readonly NekActionCategory[] = [
  "input",
  "modeModel",
  "displayNavigation",
  "other",
];

interface Recording {
  actionId: NekActionId;
  error: string | null;
}

function Keycaps({ binding }: { binding: string }) {
  return (
    <KbdGroup>
      {formatActionBindingLabelParts(binding).map((part, index) => (
        <Kbd key={`${part}-${index}`}>{part}</Kbd>
      ))}
    </KbdGroup>
  );
}

function useRecorder(
  recording: Recording | null,
  setRecording: (next: Recording | null) => void,
  overrides: ActionShortcutOverrides,
  commit: (next: ActionShortcutOverrides) => void,
) {
  const { intl } = useZCodeIntl();
  // 菜单快捷键只在桌面端存在；没有平台（Web / 测试）时只需 renderer 侧短路。
  const platform = useOptionalPlatform();
  const active = recording !== null;
  // 录制期间键盘归录制器独占：nek 动作分发器与旧命令表更早注册在同一 capture 阶段，
  // 菜单快捷键又先于 renderer 生效；不短路的话，录 Ctrl+K / Ctrl+N 会先真的执行原动作。
  useEffect(() => {
    if (!active) return undefined;
    setShortcutRecordingActive(true);
    platform?.setShortcutRecordingActive?.(true);
    return () => {
      setShortcutRecordingActive(false);
      platform?.setShortcutRecordingActive?.(false);
    };
  }, [active, platform]);
  useEffect(() => {
    if (!recording) return undefined;
    const effective = resolveEffectiveActionBindings(overrides);
    const handle = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const result = recordActionBinding(event);
      if (result.kind === "pending") return;
      if (result.kind === "cancel") {
        setRecording(null);
        return;
      }
      if (result.kind === "invalid") {
        setRecording({
          ...recording,
          error: intl.formatMessage({ id: "shortcuts.action.conflict.invalid" }),
        });
        return;
      }
      const conflict = checkActionBindingConflict(recording.actionId, result.binding, effective);
      if (conflict) {
        const action =
          conflict.kind === "occupied"
            ? intl.formatMessage({ id: nekActionLabelId(conflict.ownerActionId) })
            : "";
        setRecording({
          ...recording,
          error: intl.formatMessage(
            { id: `shortcuts.action.conflict.${conflict.kind}` },
            { action },
          ),
        });
        return;
      }
      commit({ ...overrides, [recording.actionId]: [result.binding] });
      setRecording(null);
    };
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, [recording, setRecording, overrides, commit, intl]);
}

function ImportDialog({
  open,
  onOpenChange,
  onImport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (overrides: ActionShortcutOverrides) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const focusRestore = useFocusRestore(open);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState<string[] | null>(null);
  useEffect(() => {
    if (open) {
      setText("");
      setError(null);
      setUnsupported(null);
    }
  }, [open]);
  const run = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setError(t("settings.nek.shortcuts.import.notObject"));
      return;
    }
    const result = importNekKeybindings(parsed as Record<string, string | string[]>);
    onImport(result.overrides);
    if (result.unsupported.length > 0) {
      setUnsupported(result.unsupported.map((item) => `${item.actionId}: ${item.keyId}`));
      return;
    }
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" onCloseAutoFocus={focusRestore.onCloseAutoFocus}>
        <DialogHeader className="pr-8">
          <DialogTitle>{t("settings.nek.shortcuts.import.title")}</DialogTitle>
          <DialogDescription>{t("settings.nek.shortcuts.import.description")}</DialogDescription>
        </DialogHeader>
        <Textarea
          {...TECHNICAL_INPUT_ATTRIBUTES}
          autoFocus
          aria-label={t("settings.nek.shortcuts.import.title")}
          value={text}
          placeholder={'{ "app.model.select": "ctrl+l" }'}
          className="min-h-32 font-mono"
          aria-invalid={error ? true : undefined}
          onChange={(event) => setText(event.target.value)}
        />
        {error ? (
          <p role="alert" className="text-ui-sm text-destructive">
            {error}
          </p>
        ) : null}
        {unsupported ? (
          <div role="status" className="flex flex-col gap-1 text-ui-sm">
            <p className="text-foreground">
              {t("settings.nek.shortcuts.import.partial", { count: unsupported.length })}
            </p>
            <ul className="font-mono text-foreground-subtle">
              {unsupported.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t(unsupported ? "common.close" : "common.cancel")}
          </Button>
          {unsupported ? null : (
            <Button disabled={text.trim() === ""} onClick={run}>
              {t("settings.nek.shortcuts.import.run")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ShortcutsPage() {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const overrides = useNekGuiPreferences((state) => state.preferences.actionShortcutOverrides);
  const update = useNekGuiPreferences((state) => state.update);
  const commit = (next: ActionShortcutOverrides) => update({ actionShortcutOverrides: next });
  const [recording, setRecording] = useState<Recording | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  useRecorder(recording, setRecording, overrides, commit);
  const effective = resolveEffectiveActionBindings(overrides);
  const conflicted = new Set(findActionConflicts(effective).flatMap((group) => group.actionIds));
  const resetOne = (id: NekActionId) => {
    const next: Partial<Record<NekActionId, readonly string[]>> = { ...overrides };
    delete next[id];
    commit(next);
  };

  return (
    <NekPageFrame
      usesTarget={false}
      description={t("settings.nek.shortcuts.pageDescription")}
      actions={
        <>
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <UploadIcon aria-hidden="true" />
            {t("settings.nek.shortcuts.import")}
          </Button>
          <Button
            variant="ghost"
            disabled={Object.keys(overrides).length === 0}
            onClick={() => commit({})}
          >
            <RotateCcwIcon aria-hidden="true" />
            {t("settings.nek.shortcuts.resetAll")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-8">
        {CATEGORIES.map((category) => (
          <SettingSection key={category} title={t(`settings.nek.shortcuts.category.${category}`)}>
            <div
              data-nek-list=""
              className="flex flex-col rounded-xl border border-card-border bg-card"
            >
              {NEK_ACTIONS.filter((action) => action.category === category).map((action) => {
                const bindings = effective[action.id];
                const isRecording = recording?.actionId === action.id;
                const overridden = overrides[action.id] !== undefined;
                return (
                  <div
                    key={action.id}
                    data-nek-row=""
                    tabIndex={0}
                    onKeyDown={handleRowArrowNavigation}
                    className={cn(
                      "flex flex-wrap items-center gap-3 border-b border-border px-3 py-2 outline-none last:border-b-0 focus-visible:bg-hover",
                      conflicted.has(action.id) && "bg-destructive/5",
                    )}
                  >
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="text-ui-base text-foreground">
                        {t(nekActionLabelId(action.id))}
                      </span>
                      <span className="font-mono text-ui-xs text-foreground-subtlest">
                        {action.id}
                      </span>
                      {action.desktopNoteId ? (
                        <span className="text-ui-xs text-foreground-subtle">
                          {t(action.desktopNoteId)}
                        </span>
                      ) : null}
                      {action.disabledReason ? (
                        // 当前 GUI 还没有这个动作的目标：直说原因，不让用户以为按键坏了。
                        <span role="status" className="text-ui-xs text-foreground-subtlest">
                          {t(action.disabledReason.id)}
                        </span>
                      ) : null}
                      {conflicted.has(action.id) ? (
                        <span role="alert" className="text-ui-xs text-destructive">
                          {t("settings.nek.shortcuts.conflict")}
                        </span>
                      ) : null}
                      {isRecording && recording?.error ? (
                        <span role="alert" className="text-ui-xs text-destructive">
                          {recording.error}
                        </span>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                      {isRecording ? (
                        <span role="status" className="text-ui-sm text-foreground-subtle">
                          {t("settings.nek.shortcuts.recording")}
                        </span>
                      ) : bindings.length === 0 ? (
                        <span className="text-ui-sm text-foreground-subtlest">
                          {t("settings.nek.shortcuts.unset")}
                        </span>
                      ) : (
                        bindings.map((binding) => <Keycaps key={binding} binding={binding} />)
                      )}
                      <Button
                        variant={isRecording ? "secondary" : "outline"}
                        size="sm"
                        aria-pressed={isRecording}
                        onClick={() =>
                          setRecording(isRecording ? null : { actionId: action.id, error: null })
                        }
                      >
                        <KeyboardIcon aria-hidden="true" />
                        {t(
                          isRecording
                            ? "settings.nek.shortcuts.stopRecording"
                            : "settings.nek.shortcuts.record",
                        )}
                      </Button>
                      <IconButton
                        size="icon-sm"
                        label={t("settings.nek.shortcuts.clear")}
                        disabled={bindings.length === 0}
                        disabledReason={t("settings.nek.shortcuts.unset")}
                        onClick={() => commit({ ...overrides, [action.id]: [] })}
                      >
                        <XIcon />
                      </IconButton>
                      <IconButton
                        size="icon-sm"
                        label={t("ui.setting.resetToDefault")}
                        disabled={!overridden}
                        disabledReason={t("settings.nek.shortcuts.isDefault")}
                        onClick={() => resetOne(action.id)}
                      >
                        <RotateCcwIcon />
                      </IconButton>
                    </div>
                  </div>
                );
              })}
            </div>
          </SettingSection>
        ))}
      </div>
      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImport={(imported) => commit({ ...overrides, ...imported })}
      />
    </NekPageFrame>
  );
}
