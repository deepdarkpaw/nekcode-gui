/**
 * 添加 / 编辑远程主机：复用现有远程连接表单（useRemoteConnectionForm + RemoteConnectionFields，
 * 支持手填与从 ~/.ssh/config 选择），外加别名。编辑时密码留空表示保持已保存的密码。
 */
import { useEffect, useId, useState } from "react";
import type { RemoteTarget } from "@zcode/shared";
import { Input } from "@/components/ui/input.js";
import { useRemoteConnectionForm } from "@/hooks/useRemoteConnectionForm.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { buildRemoteTarget } from "@/lib/remoteConnectionWizard.js";
import { RemoteConnectionFields } from "@/RemoteConnectionFields.js";
import type { NekRemoteHost } from "../../api/hostApi.js";
import { Field, invalidProps } from "../../components/Field.js";
import { Segmented } from "../../components/inputs.js";
import { NekFormDialog } from "../../components/NekFormDialog.js";

type Form = ReturnType<typeof useRemoteConnectionForm>;

function prefill(form: Form, target: RemoteTarget): void {
  form.setKind(target.kind);
  if (target.kind === "ssh") {
    form.setHost(target.host);
    form.setPort(target.port ? String(target.port) : "22");
    form.setUsername(target.username);
    form.setSshAuthMethod(target.privateKeyPath ? "privateKey" : "password");
    form.setPrivateKeyPath(target.privateKeyPath ?? "");
  } else if (target.kind === "wsl") {
    form.setWslDistro(target.distro ?? "");
    form.setWslUser(target.user ?? "");
  } else {
    form.setManualDockerContainer(target.container);
  }
}

/** 表单 → 目标；编辑且密码留空时保持原密码（目标里不带 password）。 */
function buildTarget(
  form: Form,
  intl: { formatMessage: (d: { id: string }) => string },
  editing: boolean,
) {
  const keepPassword =
    editing && form.kind === "ssh" && form.sshAuthMethod === "password" && form.password === "";
  const result = buildRemoteTarget(intl, {
    ...form,
    password: keepPassword ? "kept" : form.password,
  });
  if (keepPassword && result.target?.kind === "ssh") {
    const { password: _kept, ...rest } = result.target;
    return { target: rest as RemoteTarget };
  }
  return result;
}

export function HostEditDialog({
  open,
  onOpenChange,
  host,
  isWindowsDesktop,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  host?: NekRemoteHost;
  isWindowsDesktop: boolean;
  onSave: (alias: string, target: RemoteTarget) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const aliasId = useId();
  const form = useRemoteConnectionForm({ open, isWindowsDesktop });
  const [alias, setAlias] = useState("");
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!open) return;
    setAlias(host?.alias ?? "");
    setTouched(false);
    if (host) prefill(form, host.target);
    // 只在打开时预填；form 每次渲染都是新对象。
  }, [open, host]);
  const built = buildTarget(form, intl, Boolean(host));
  const aliasError = alias.trim() === "" ? t("settings.nek.hosts.error.aliasRequired") : undefined;
  return (
    <NekFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t(host ? "settings.nek.hosts.editTitle" : "settings.nek.hosts.addTitle")}
      description={t("settings.nek.hosts.formDescription")}
      dirty={touched}
      valid={!aliasError && Boolean(built.target)}
      saveLabel={t(host ? "settings.nek.hosts.save" : "settings.nek.hosts.add")}
      onSave={async () => {
        if (built.target) await onSave(alias.trim(), built.target);
      }}
    >
      {({ attempted }) => (
        <div className="flex flex-col gap-4" onInput={() => setTouched(true)}>
          <Field
            label={t("settings.nek.hosts.alias")}
            htmlFor={aliasId}
            required
            error={attempted ? aliasError : undefined}
          >
            <Input
              id={aliasId}
              required
              value={alias}
              placeholder="dev-box"
              {...invalidProps(aliasId, attempted ? aliasError : undefined)}
              onChange={(event) => setAlias(event.target.value)}
            />
          </Field>
          {form.availableKinds.length > 1 && !host ? (
            <Segmented
              ariaLabel={t("settings.nek.hosts.kind")}
              value={form.kind}
              options={form.availableKinds.map((kind) => ({
                value: kind,
                label: t(`settings.nek.hosts.kind.${kind}`),
              }))}
              onChange={(kind) => {
                setTouched(true);
                form.setKind(kind);
              }}
            />
          ) : null}
          <RemoteConnectionFields
            kind={form.kind}
            host={form.host}
            port={form.port}
            username={form.username}
            sshAuthMethod={form.sshAuthMethod}
            password={form.password}
            privateKeyPath={form.privateKeyPath}
            privateKeyPassphrase={form.privateKeyPassphrase}
            wslDistro={form.wslDistro}
            wslUser={form.wslUser}
            wslDistros={form.wslDistros}
            dockerContainer={form.dockerContainer}
            manualDockerContainer={form.manualDockerContainer}
            dockerContainers={form.dockerContainers}
            dockerAvailable={form.dockerAvailable}
            sshConfigAliases={form.sshConfigAliases}
            sshConfigAliasesLoading={form.sshConfigAliasesLoading}
            sshConfigAliasesError={form.sshConfigAliasesError}
            selectedSshConfigAlias={form.selectedSshConfigAlias}
            runtimeOptionsLoading={form.currentRuntimeOptionsLoading}
            refreshDockerContainers={form.refreshDockerContainers}
            applySshConfigAlias={(option) => {
              setTouched(true);
              form.applySshConfigAlias(option);
              if (!alias) setAlias(option.alias);
            }}
            clearSelectedSshConfigAlias={form.clearSelectedSshConfigAlias}
            setHost={form.setHost}
            setPort={form.setPort}
            setUsername={form.setUsername}
            setSshAuthMethod={form.setSshAuthMethod}
            setPassword={form.setPassword}
            setPrivateKeyPath={form.setPrivateKeyPath}
            setPrivateKeyPassphrase={form.setPrivateKeyPassphrase}
            setWslDistro={form.setWslDistro}
            setWslUser={form.setWslUser}
            setDockerContainer={form.setDockerContainer}
            setManualDockerContainer={form.setManualDockerContainer}
          />
          {host && form.kind === "ssh" && form.sshAuthMethod === "password" ? (
            <p className="text-ui-sm text-foreground-subtle">
              {t("settings.nek.hosts.keepPassword")}
            </p>
          ) : null}
          {attempted && built.errorMessage ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {built.errorMessage}
            </p>
          ) : null}
        </div>
      )}
    </NekFormDialog>
  );
}
