import { z } from "zod";

// ---------- Credentials + status ----------

export const BitbucketCredentialsSchema = z.object({
  workspace: z.string().min(1),
  email: z.string().email(),
  api_token: z.string().min(1),
  ssh_private_key: z.string().optional(),
  ssh_public_key: z.string().optional(),
  ssh_passphrase: z.string().optional(),
});
export type BitbucketCredentials = z.infer<typeof BitbucketCredentialsSchema>;

export const BitbucketUserSchema = z.object({
  account_id: z.string(),
  display_name: z.string(),
  email: z.string().optional(),
  avatar_url: z.string().optional(),
});
export type BitbucketUser = z.infer<typeof BitbucketUserSchema>;

export const BitbucketStatusResultSchema = z.discriminatedUnion("connected", [
  z.object({
    connected: z.literal(true),
    user: BitbucketUserSchema,
    workspace: z.string(),
    repos_count: z.number().int().nonnegative(),
    has_ssh_key: z.boolean().optional(),
    last_tested_at: z.number().int().nonnegative().optional(),
  }),
  z.object({
    connected: z.literal(false),
    reason: z.enum(["not_configured", "auth_failed", "network_error", "unknown"]),
    message: z.string().optional(),
  }),
]);
export type BitbucketStatusResult = z.infer<typeof BitbucketStatusResultSchema>;

// ---------- Domain entities ----------

export const BitbucketRepoSchema = z.object({
  full_name: z.string(),
  slug: z.string(),
  workspace: z.string(),
  default_branch: z.string(),
  language: z.string().nullable(),
  description: z.string().nullable(),
  clone_url: z.string().nullable(),
  web_url: z.string(),
});
export type BitbucketRepo = z.infer<typeof BitbucketRepoSchema>;

export const BitbucketPRStateSchema = z.enum([
  "OPEN",
  "MERGED",
  "DECLINED",
  "SUPERSEDED",
]);
export type BitbucketPRState = z.infer<typeof BitbucketPRStateSchema>;

export const BitbucketPRSchema = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  source_branch: z.string(),
  target_branch: z.string(),
  author: BitbucketUserSchema,
  state: BitbucketPRStateSchema,
  created_on: z.string(),
  updated_on: z.string(),
  repository: z.object({
    full_name: z.string(),
    slug: z.string(),
    workspace: z.string(),
  }),
  head_sha: z.string(),
  web_url: z.string(),
});
export type BitbucketPR = z.infer<typeof BitbucketPRSchema>;

export const BitbucketPRListResultSchema = z.object({
  items: z.array(BitbucketPRSchema),
  next: z.string().nullable(),
});
export type BitbucketPRListResult = z.infer<typeof BitbucketPRListResultSchema>;

// ---------- Workspaces ----------

export const BitbucketWorkspaceSchema = z.object({
  slug: z.string(),
  name: z.string(),
  uuid: z.string().optional(),
});
export type BitbucketWorkspace = z.infer<typeof BitbucketWorkspaceSchema>;

// ---------- IPC args ----------

export const BitbucketStatusArgsSchema = z.object({}).strict().optional();
export type BitbucketStatusArgs = z.infer<typeof BitbucketStatusArgsSchema>;

export const BitbucketRepoSearchArgsSchema = z.object({
  query: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
});
export type BitbucketRepoSearchArgs = z.infer<typeof BitbucketRepoSearchArgsSchema>;

export const BitbucketPRListArgsSchema = z.object({
  workspace: z.string().optional(),
  repo_slug: z.string().optional(),
  state: BitbucketPRStateSchema.optional(),
  limit: z.number().int().positive().max(100).optional(),
});
export type BitbucketPRListArgs = z.infer<typeof BitbucketPRListArgsSchema>;

export const BitbucketPRGetArgsSchema = z.object({
  workspace: z.string().min(1),
  repo_slug: z.string().min(1),
  pr_id: z.number().int().positive(),
});
export type BitbucketPRGetArgs = z.infer<typeof BitbucketPRGetArgsSchema>;

export const BitbucketPRDiffArgsSchema = BitbucketPRGetArgsSchema;
export type BitbucketPRDiffArgs = z.infer<typeof BitbucketPRDiffArgsSchema>;

export const BitbucketPRActionArgsSchema = BitbucketPRGetArgsSchema.extend({
  body: z.string().optional(),
});
export type BitbucketPRActionArgs = z.infer<typeof BitbucketPRActionArgsSchema>;

export const BitbucketPRCommentArgsSchema = BitbucketPRGetArgsSchema.extend({
  content: z.string().min(1),
  inline: z
    .object({
      path: z.string().min(1),
      from: z.number().int().positive().optional(),
      to: z.number().int().positive().optional(),
    })
    .optional(),
});
export type BitbucketPRCommentArgs = z.infer<typeof BitbucketPRCommentArgsSchema>;

// ---------- App settings ----------

export const BITBUCKET_SETTINGS_KEY = "bitbucket";

export const BitbucketAppSettingsSchema = z.object({
  workspace: z.string().optional(),
  last_tested_at: z.number().int().nonnegative().optional(),
});
export type BitbucketAppSettings = z.infer<typeof BitbucketAppSettingsSchema>;
