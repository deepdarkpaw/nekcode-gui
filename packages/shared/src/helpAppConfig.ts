import { z } from "zod";

const helpUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => /^https?:\/\//iu.test(value))
  .optional()
  .catch(undefined);
const helpConfigSchema = z.object({
  community_urls: z
    .object({
      "zh-CN": helpUrlSchema,
      "en-US": helpUrlSchema,
    })
    .optional()
    .catch(undefined),
});
export type HelpAppConfig = z.infer<typeof helpConfigSchema>;

/** 帮助入口只由随包本地配置提供，不接受官方远端覆盖。 */
export function resolveHelpAppConfig(local: unknown): HelpAppConfig {
  const config = helpConfigSchema.safeParse(local).data;
  return {
    community_urls: {
      "zh-CN": config?.community_urls?.["zh-CN"],
      "en-US": config?.community_urls?.["en-US"],
    },
  };
}
