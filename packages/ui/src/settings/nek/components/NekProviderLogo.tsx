/**
 * 服务商图标：按服务商 ID / Base URL 中的关键字匹配已打包的第三方图标，匹配不到用通用图标。
 * 复用 model-provider-section 的图标资源。
 */
import { useState } from "react";
import { PackageIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { resolveTheme } from "@/useTheme.js";
import anthropicLogo from "@/assets/provider-icons/model-provider-anthropic.png";
import deepSeekLogo from "@/assets/provider-icons/model-provider-deepseek.png";
import openAiLogo from "@/assets/provider-icons/model-provider-openai.png";
import moonshotKimiLogo from "@/assets/provider-icons/model-provider-moonshot-kimi.png";
import miniMaxLogo from "@/assets/provider-icons/model-provider-minimax.png";
import alibabaLogo from "@/assets/provider-icons/model-provider-alibaba-cloud.png";
import xAiLogo from "@/assets/provider-icons/model-provider-xai.png";
import zaiLogo from "@/assets/provider-icons/model-provider-zai-app.png";
import openrouterLight from "@/assets/provider-icons/model-provider-openrouter-light.svg";
import openrouterDark from "@/assets/provider-icons/model-provider-openrouter-dark.svg";

const LOGOS: ReadonlyArray<{ match: RegExp; light: string; dark?: string }> = [
  { match: /anthropic|claude/, light: anthropicLogo },
  { match: /deepseek/, light: deepSeekLogo },
  { match: /openrouter/, light: openrouterLight, dark: openrouterDark },
  { match: /openai|codex|chatgpt/, light: openAiLogo },
  { match: /moonshot|kimi/, light: moonshotKimiLogo },
  { match: /minimax/, light: miniMaxLogo },
  { match: /dashscope|qwen|alibaba|aliyun/, light: alibabaLogo },
  { match: /x\.ai|xai|grok/, light: xAiLogo },
  { match: /z\.ai|zhipu|bigmodel|glm/, light: zaiLogo },
];

export function NekProviderLogo({ hint, className }: { hint: string; className?: string }) {
  const theme = useZCodeStoreWithDefault((state) => state.theme, "zai-dark");
  const [failed, setFailed] = useState<string | null>(null);
  const entry = LOGOS.find((logo) => logo.match.test(hint.toLowerCase()));
  const src = entry
    ? resolveTheme(theme) === "dark"
      ? (entry.dark ?? entry.light)
      : entry.light
    : null;
  if (!src || failed === src) {
    return (
      <PackageIcon
        className={cn("shrink-0 text-foreground-subtle", className)}
        aria-hidden="true"
      />
    );
  }
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      className={cn("shrink-0 object-contain", className)}
      onError={() => setFailed(src)}
    />
  );
}
