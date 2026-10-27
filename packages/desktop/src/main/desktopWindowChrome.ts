import { app, BrowserWindow, Menu, nativeImage, nativeTheme, screen } from "electron";
import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";
import type { DesktopTitleBarTheme, Locale } from "@zcode/shared";
import {
  DEFAULT_LOCALE,
  desktopMenuMessageIds,
  getDesktopMenuMessage,
  PlatformChannels,
} from "@zcode/shared";
import { loadWindow, type WindowBootstrapOptions } from "./desktopHostProcess.js";
import {
  buildWindowsTitleBarOverlayForZoomLevel,
  hasCustomWindowsControls,
  registerCustomWindowsControls,
  MACOS_TRAFFIC_LIGHT_BASE_POSITION,
  syncWindowControlsOverlayForZoomLevel,
} from "./desktopWindowButtonPosition.js";
import {
  clampDesktopZoomLevel,
  resolveDesktopZoomFactorForLevel,
  resolveDesktopZoomLevelFromFactor,
} from "./desktopZoom.js";
import { resolveDesktopWindowChromeState } from "./desktopWindowChromeState.js";
import {
  MIN_DESKTOP_WINDOW_HEIGHT,
  MIN_DESKTOP_WINDOW_WIDTH,
  resolveDesktopWindowSize,
  type DesktopWindowSize,
} from "./desktopWindowSize.js";
function isLinuxDesktopWindow() {
  return process.platform === "linux";
}

function buildDesktopWindowVisualOptions() {
  if (process.platform === "darwin") {
    return {
      backgroundColor: "#00000000",
      titleBarStyle: "hidden" as const,
      trafficLightPosition: MACOS_TRAFFIC_LIGHT_BASE_POSITION,
      vibrancy: "under-window" as const,
      visualEffectState: "active" as const,
    };
  }

  if (process.platform === "win32") {
    return {
      backgroundColor: "#00000000",
      // Windows 窗口操作由 renderer 绘制，禁用原生标题栏，避免出现两套按钮。
      frame: false,
      backgroundMaterial: "acrylic" as const,
    };
  }

  return {
    // 不透明 BrowserWindow 会把 renderer 的圆角裁切重新填成直角黑底，
    // Linux 外壳无法与内层 12px 面板形成同心圆弧。透明底只负责露出四角，
    // renderer 根面仍使用不透明 token，避免桌面底色混入侧栏。
    backgroundColor: "#00000000",
    transparent: true,
    // Linux 原生标题栏会和 renderer 自绘顶部菜单重复，隐藏 frame 后统一用自定义窗口控制。
    frame: false,
    // Linux 部分窗口管理器会给 frameless 窗口绘制额外外侧阴影/描边，
    // 用户看到的是窗口外缘黑线。只在 Linux 禁用系统阴影，避免影响 macOS/Windows 的原生材质。
    hasShadow: false,
  };
}

export function applyAppIcon(iconPath: string) {
  if (process.platform !== "darwin" || app.dock == null) {
    return;
  }

  // TypeScript 不会因为 process.platform === "darwin" 自动收窄 app.dock。
  // app.dock 的类型在定义上仍然可能是 undefined，直接调用会持续报 ts(18048)。
  // 这里把平台判断和空值判断合并，既符合运行时语义，也让类型系统明确知道 Dock 一定存在。
  const dockIcon = nativeImage.createFromPath(iconPath);
  if (!dockIcon.isEmpty()) {
    app.dock.setIcon(dockIcon);
  }
}

function syncWindowFullscreenState(targetWindow: BrowserWindow) {
  if (targetWindow.isDestroyed()) {
    return;
  }

  targetWindow.webContents.send(
    PlatformChannels.WindowFullscreenChanged,
    targetWindow.isFullScreen(),
  );
}

function syncDesktopWindowChromeState(targetWindow: BrowserWindow) {
  if (targetWindow.isDestroyed()) return;

  targetWindow.webContents.send(
    PlatformChannels.DesktopWindowChromeStateChanged,
    resolveDesktopWindowChromeState(targetWindow.isMaximized()),
  );
}

export function getWindowOverlayTheme(): Exclude<DesktopTitleBarTheme, "system"> {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

export function applyWindowsTitleBarTheme(
  targetWindow: BrowserWindow,
  theme: DesktopTitleBarTheme,
) {
  if (
    process.platform !== "win32" ||
    targetWindow.isDestroyed() ||
    hasCustomWindowsControls(targetWindow)
  ) {
    return;
  }

  const resolvedTheme = theme === "system" ? getWindowOverlayTheme() : theme;
  const zoomLevel = resolveDesktopZoomLevelFromFactor(targetWindow.webContents.getZoomFactor());
  targetWindow.setTitleBarOverlay(
    buildWindowsTitleBarOverlayForZoomLevel(zoomLevel, resolvedTheme),
  );
}

function attachWindowsWindowRepaint(targetWindow: BrowserWindow) {
  if (process.platform !== "win32") {
    return;
  }

  let pendingRepaintTimer: ReturnType<typeof setTimeout> | null = null;
  const repaint = () => {
    if (targetWindow.isDestroyed() || targetWindow.webContents.isDestroyed()) {
      return;
    }

    targetWindow.webContents.invalidate();
  };

  const scheduleRepaint = () => {
    repaint();
    if (pendingRepaintTimer !== null) {
      clearTimeout(pendingRepaintTimer);
    }
    pendingRepaintTimer = setTimeout(() => {
      pendingRepaintTimer = null;
      repaint();
    }, 32);
  };

  targetWindow.on("resized", () => {
    // Windows 手动拉伸结束后，Electron/Chromium 偶发只更新窗口 bounds，
    // 但 renderer 最后一帧没有完整 repaint，新扩展区域会留下宿主底色。resized 是低频结束事件，
    // 这里补一次完整窗口重绘，确保内容层按最终 viewport 尺寸重新铺满。
    scheduleRepaint();
  });
  targetWindow.on("show", () => {
    // Windows Acrylic 窗口 hide 到托盘后再次 show 时可能继续复用失效的合成 surface，
    // renderer 与 host 仍存活但窗口只剩宿主底色；复用 resize 的有界双帧重绘，不 reload renderer 或会话。
    scheduleRepaint();
  });
}

function buildTextContextMenuTemplate(
  params: ContextMenuParams,
  locale: Locale,
): MenuItemConstructorOptions[] {
  if (params.isEditable) {
    const getLabel = (id: (typeof desktopMenuMessageIds)[keyof typeof desktopMenuMessageIds]) =>
      getDesktopMenuMessage(locale, id);

    return [
      {
        label: getLabel(desktopMenuMessageIds.editUndo),
        role: "undo",
        enabled: params.editFlags.canUndo,
      },
      {
        label: getLabel(desktopMenuMessageIds.editRedo),
        role: "redo",
        enabled: params.editFlags.canRedo,
      },
      { type: "separator" },
      {
        label: getLabel(desktopMenuMessageIds.editCut),
        role: "cut",
        enabled: params.editFlags.canCut,
      },
      {
        label: getLabel(desktopMenuMessageIds.editCopy),
        role: "copy",
        enabled: params.editFlags.canCopy,
      },
      {
        label: getLabel(desktopMenuMessageIds.editPaste),
        role: "paste",
        enabled: params.editFlags.canPaste,
      },
      {
        label: getLabel(desktopMenuMessageIds.editDelete),
        role: "delete",
        enabled: params.editFlags.canDelete,
      },
      { type: "separator" },
      {
        label: getLabel(desktopMenuMessageIds.editSelectAll),
        role: "selectAll",
        enabled: params.editFlags.canSelectAll,
      },
    ];
  }

  if (params.selectionText.trim().length > 0) {
    return [{ role: "copy", enabled: params.editFlags.canCopy }];
  }

  return [];
}

export function createBrowserWindow(options: {
  iconPath: string;
  preloadPath: string;
  title?: string;
  bootstrap?: WindowBootstrapOptions;
  logger: { warn: (...args: unknown[]) => void };
  /** 桌面端持久化页面缩放档位；窗口创建时先应用，避免首屏回到默认大小。 */
  initialDesktopZoomLevel?: number;
  /** 主进程设置服务读取的最近一次普通窗口尺寸与最大化状态。 */
  initialWindowSize?: DesktopWindowSize;
  /** 每次弹出原生菜单时读取，确保应用切换语言后无需重建窗口。 */
  currentApplicationLocale?: () => Locale;
}): BrowserWindow {
  const initialDesktopZoomLevel = clampDesktopZoomLevel(options.initialDesktopZoomLevel ?? 0);
  const initialDesktopZoomFactor = resolveDesktopZoomFactorForLevel(initialDesktopZoomLevel);
  const initialWindowSize = resolveDesktopWindowSize(
    options.initialWindowSize,
    screen.getPrimaryDisplay().workAreaSize,
  );
  const win = new BrowserWindow({
    width: initialWindowSize.width,
    height: initialWindowSize.height,
    minWidth: MIN_DESKTOP_WINDOW_WIDTH,
    // 1280x720 桌面环境的可用高度通常低于 768，过高的最小高度会导致用户无法继续缩小窗口。
    minHeight: MIN_DESKTOP_WINDOW_HEIGHT,
    title: options.title,
    icon: options.iconPath,
    // Linux frameless 后部分桌面环境仍可能显示 Electron 原生菜单栏，自动隐藏避免顶部出现两套菜单。
    autoHideMenuBar: isLinuxDesktopWindow(),
    ...buildDesktopWindowVisualOptions(),
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      zoomFactor: initialDesktopZoomFactor,
    },
  });

  // 缩放命令原本只改当前运行窗口，没有在重启后恢复。
  // 创建窗口时由 main 进程先应用 setting.json 中的桌面缩放档位，同时覆盖 Chromium 可能残留的 per-host zoom。
  win.webContents.setZoomFactor(initialDesktopZoomFactor);
  if (process.platform === "win32") registerCustomWindowsControls(win);
  syncWindowControlsOverlayForZoomLevel(win, initialDesktopZoomLevel);

  if (initialWindowSize.maximized) {
    win.maximize();
  }

  win.on("enter-full-screen", () => {
    syncWindowFullscreenState(win);
  });
  win.on("leave-full-screen", () => {
    syncWindowFullscreenState(win);
  });
  win.on("maximize", () => syncDesktopWindowChromeState(win));
  win.on("unmaximize", () => syncDesktopWindowChromeState(win));
  attachWindowsWindowRepaint(win);

  win.webContents.once("did-finish-load", () => {
    // 生产包使用 loadFile(file://...) 导航时，Chromium 可能在页面加载完成后重放
    // origin 级 zoom 状态，把窗口创建阶段设置的持久化缩放覆盖回默认值。
    // did-finish-load 后再按 setting.json 的档位重放一次，确保生产包和开发态 localhost 行为一致。
    win.webContents.setZoomFactor(initialDesktopZoomFactor);
    syncWindowControlsOverlayForZoomLevel(win, initialDesktopZoomLevel);
    syncWindowFullscreenState(win);
  });
  win.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      // 导航失败时 CDP target 元数据可能仍保留原 file:// URL，而 renderer
      // 实际 document 已经进入 chrome-error://；记录主 frame 失败才能定位真实导航根因。
      options.logger.warn("[desktop-window] renderer did-fail-load", {
        errorCode,
        errorDescription,
        validatedURL,
        webContentsId: win.webContents.id,
      });
    },
  );

  win.webContents.on("context-menu", (_event, params) => {
    // 只设置 Electron role 时，菜单文案跟随系统/Electron 语言，可能与应用语言不一致。
    // 每次右键时读取当前 locale 并显式设置 label，切换语言后下一次打开即可生效。
    const template = buildTextContextMenuTemplate(
      params,
      options.currentApplicationLocale?.() ?? DEFAULT_LOCALE,
    );

    if (!app.isPackaged) {
      if (template.length > 0) {
        template.push({ type: "separator" });
      }
      template.push({
        label: "Inspect Element",
        click: () => {
          win.webContents.inspectElement(params.x, params.y);
        },
      });
    }

    if (template.length === 0) {
      return;
    }

    // 之前为避免和终端等 DOM 右键菜单双弹，生产环境完全不弹 Electron 原生菜单；
    // 但普通文本选区和输入框没有 DOM 菜单，导致右键复制/粘贴像被禁用。这里仅在文本编辑语义下补原生菜单。
    Menu.buildFromTemplate(template).popup({ window: win });
  });

  void Promise.resolve(loadWindow(win, "index", options.bootstrap)).catch((error: unknown) => {
    // loadFile/loadURL 返回的导航 Promise 过去被丢弃，长跑中的导航失败
    // 只会表现为 chrome-error 页面，主进程日志没有原始异常可供追踪。
    options.logger.warn("[desktop-window] renderer navigation rejected", error);
  });
  return win;
}
