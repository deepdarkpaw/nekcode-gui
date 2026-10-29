export type DesktopProductFlavor = "production" | "preview";

export interface DesktopProductIdentity {
  flavor: DesktopProductFlavor;
  appId: string;
  productName: string;
  linuxExecutableName: string;
  linuxPackageName: string;
}

export declare const desktopProductIdentities: Record<DesktopProductFlavor, DesktopProductIdentity>;

export declare const ZCODE_PREVIEW_IDENTITY_ENV: string;

/** 深链 / OAuth 回调共用的协议 scheme（与 electron-builder `protocols` 注册同源）。 */
export declare const NEKCODE_DEEP_LINK_SCHEME: string;

export function resolveGithubPublishOwner(env?: Record<string, string | undefined>): string;
export function resolveGithubPublishRepo(env?: Record<string, string | undefined>): string;

export function isPreviewIdentityRequested(env?: Record<string, string | undefined>): boolean;
export function resolveDesktopProductFlavor(
  env?: Record<string, string | undefined>,
): DesktopProductFlavor;
export function resolveDesktopProductIdentity(
  env?: Record<string, string | undefined>,
): DesktopProductIdentity;
export function resolveDesktopArtifactSuffix(env?: Record<string, string | undefined>): string;
export function resolveWindowsAppUserModelIdForFlavor(
  flavor: DesktopProductFlavor,
  runtime?: { isPackaged?: boolean },
): string;
export function resolveWindowsAppUserModelId(
  env?: Record<string, string | undefined>,
  runtime?: { isPackaged?: boolean },
): string;
