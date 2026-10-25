/**
 * 配置目标切换（本机 / 已连接的远程主机）。触发器上始终显示当前目标主机名，防止改错机器；
 * 未连接的主机灰色显示，选择它会先连接再切换。
 */
import { CheckIcon, ChevronDownIcon, LaptopIcon, LoaderIcon, ServerIcon } from "lucide-react";
import { useState } from "react";
import type { NekConfigTargetInfo } from "@zcode/shared/nek-protocol";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { targetKeyOf, useNekHostApi, useNekTarget } from "../api/NekSettingsContext.js";

function TargetIcon({
  info,
  className,
}: {
  info: NekConfigTargetInfo | undefined;
  className?: string;
}) {
  return info?.target.kind === "remote" ? (
    <ServerIcon className={className} aria-hidden="true" />
  ) : (
    <LaptopIcon className={className} aria-hidden="true" />
  );
}

export function TargetSwitcher() {
  const { intl } = useZCodeIntl();
  const host = useNekHostApi();
  const { targets, targetKey, targetInfo, setTarget, refreshTargets } = useNekTarget();
  const [connecting, setConnecting] = useState<string | null>(null);

  const choose = async (info: NekConfigTargetInfo) => {
    if (info.connected || info.target.kind === "local") {
      setTarget(info.target);
      return;
    }
    setConnecting(info.target.connectionId);
    try {
      await host.connectHost(info.target.connectionId);
      await refreshTargets();
      setTarget(info.target);
    } catch (error) {
      toast(
        intl.formatMessage(
          { id: "settings.nek.target.connectFailed" },
          { host: info.label, reason: getErrorMessage(error) },
        ),
        { variant: "warning" },
      );
    } finally {
      setConnecting(null);
    }
  };

  const label = targetInfo?.label ?? intl.formatMessage({ id: "settings.nek.target.loading" });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="lg"
          data-slot="nek-target-switcher"
          aria-label={intl.formatMessage(
            { id: "settings.nek.target.switchLabel" },
            { host: label },
          )}
          className={cn(
            "max-w-72 justify-start gap-2",
            targetInfo && !targetInfo.connected && "text-foreground-subtle",
          )}
        >
          <TargetIcon info={targetInfo} className="size-4" />
          <span className="truncate font-medium">{label}</span>
          {targetInfo?.detail ? (
            <span className="truncate font-mono text-ui-sm text-foreground-subtle">
              {targetInfo.detail}
            </span>
          ) : null}
          <ChevronDownIcon
            className="ml-auto size-3.5 text-foreground-subtlest"
            aria-hidden="true"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-72">
        <DropdownMenuLabel>
          {intl.formatMessage({ id: "settings.nek.target.menuTitle" })}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {targets.list.map((info) => {
          const key = targetKeyOf(info.target);
          const disconnected = !info.connected;
          const isConnecting =
            info.target.kind === "remote" && connecting === info.target.connectionId;
          return (
            <DropdownMenuItem
              key={key}
              onSelect={(event) => {
                if (disconnected) {
                  event.preventDefault();
                }
                void choose(info);
              }}
              className={cn("gap-2", disconnected && "text-foreground-subtlest")}
            >
              <TargetIcon info={info} className="size-4" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{info.label}</span>
                {info.detail ? (
                  <span className="truncate font-mono text-ui-xs text-foreground-subtlest">
                    {info.detail}
                  </span>
                ) : null}
              </span>
              {isConnecting ? (
                <LoaderIcon className="size-3.5 animate-spin" aria-hidden="true" />
              ) : disconnected ? (
                <span className="text-ui-xs text-foreground-subtle">
                  {intl.formatMessage({ id: "settings.nek.target.connect" })}
                </span>
              ) : key === targetKey ? (
                <CheckIcon className="size-3.5" aria-hidden="true" />
              ) : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
