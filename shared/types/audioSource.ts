import { z } from "zod/v4";

/** 共用选源偏好，旧配置缺失的校验开关在输入边界补齐 */
export const audioSourcePreferencesSchema = z.object({
  preferPluginSource: z.boolean(),
  allowTrialPlay: z.boolean(),
  verifySourceArtist: z.boolean().default(false),
  verifySourceDuration: z.boolean().default(true),
});

export type AudioSourcePreferences = z.infer<typeof audioSourcePreferencesSchema>;
