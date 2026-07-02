import { z } from "zod";

// ---------- Credentials + status ----------

export const JiraCredentialsSchema = z.object({
  /** Site root — e.g. `https://acme.atlassian.net`. No trailing slash. */
  base_url: z.string().url(),
  email: z.string().email(),
  /** Atlassian API token. */
  api_token: z.string().min(1),
});
export type JiraCredentials = z.infer<typeof JiraCredentialsSchema>;

export const JiraStatusResultSchema = z.discriminatedUnion("connected", [
  z.object({
    connected: z.literal(true),
    user: z.object({
      account_id: z.string(),
      display_name: z.string(),
      email: z.string().optional(),
      avatar_url: z.string().optional(),
    }),
    base_url: z.string().optional(),
    projects_count: z.number().int().nonnegative(),
    last_tested_at: z.number().int().nonnegative().optional(),
  }),
  z.object({
    connected: z.literal(false),
    reason: z.enum(["not_configured", "auth_failed", "network_error", "unknown"]),
    message: z.string().optional(),
  }),
]);
export type JiraStatusResult = z.infer<typeof JiraStatusResultSchema>;

// ---------- Domain entities ----------

export const JiraUserSchema = z.object({
  account_id: z.string(),
  display_name: z.string(),
  email: z.string().optional(),
  avatar_url: z.string().optional(),
});
export type JiraUser = z.infer<typeof JiraUserSchema>;

export const JiraProjectSchema = z.object({
  key: z.string(),
  name: z.string(),
  project_type: z.string().optional(),
  avatar_url: z.string().optional(),
});
export type JiraProject = z.infer<typeof JiraProjectSchema>;

export const JiraIssueTypeSchema = z.enum([
  "Bug",
  "Task",
  "Story",
  "Epic",
  "Subtask",
  "Incident",
  "Other",
]);
export type JiraIssueType = z.infer<typeof JiraIssueTypeSchema>;

export const JiraPrioritySchema = z.enum([
  "Highest",
  "High",
  "Medium",
  "Low",
  "Lowest",
  "Unknown",
]);
export type JiraPriority = z.infer<typeof JiraPrioritySchema>;

export const JiraIssueSummarySchema = z.object({
  key: z.string(),
  id: z.string(),
  summary: z.string(),
  status: z.string(),
  status_category: z.enum(["new", "indeterminate", "done", "unknown"]),
  priority: JiraPrioritySchema,
  issue_type: z.string(),
  assignee: JiraUserSchema.nullable(),
  reporter: JiraUserSchema.nullable(),
  created: z.string(),
  updated: z.string(),
  project_key: z.string(),
  labels: z.array(z.string()).default([]),
});
export type JiraIssueSummary = z.infer<typeof JiraIssueSummarySchema>;

export const JiraCommentSchema = z.object({
  id: z.string(),
  author: JiraUserSchema,
  body_html: z.string(),
  created: z.string(),
  updated: z.string().optional(),
});
export type JiraComment = z.infer<typeof JiraCommentSchema>;

export const JiraTransitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  to_status: z.string(),
  to_status_category: z.enum(["new", "indeterminate", "done", "unknown"]),
});
export type JiraTransition = z.infer<typeof JiraTransitionSchema>;

export const JiraIssueSchema = JiraIssueSummarySchema.extend({
  description_html: z.string().nullable(),
  comments: z.array(JiraCommentSchema),
  transitions: z.array(JiraTransitionSchema),
  url: z.string().url(),
});
export type JiraIssue = z.infer<typeof JiraIssueSchema>;

// ---------- Filter shape ----------

export const JiraFilterSchema = z.object({
  project_keys: z.array(z.string()).optional(),
  assignees: z.array(z.string()).optional(),
  statuses: z.array(z.string()).optional(),
  status_not: z.boolean().optional(),
  priorities: z.array(JiraPrioritySchema).optional(),
  issue_types: z.array(z.string()).optional(),
  created_after: z.string().optional(),
  created_before: z.string().optional(),
  updated_after: z.string().optional(),
  updated_before: z.string().optional(),
  text: z.string().optional(),
});
export type JiraFilter = z.infer<typeof JiraFilterSchema>;

// ---------- Search args + results ----------

export const JiraSearchArgsSchema = z.object({
  filter: JiraFilterSchema,
  limit: z.number().int().positive().max(500).optional(),
  offset: z.number().int().nonnegative().optional(),
  sort: z
    .object({
      field: z.enum([
        "key",
        "summary",
        "priority",
        "status",
        "assignee",
        "created",
        "updated",
      ]),
      direction: z.enum(["asc", "desc"]),
    })
    .optional(),
});
export type JiraSearchArgs = z.infer<typeof JiraSearchArgsSchema>;

export const JiraSearchResultSchema = z.object({
  issues: z.array(JiraIssueSummarySchema),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
});
export type JiraSearchResult = z.infer<typeof JiraSearchResultSchema>;

export const JiraIssueGetArgsSchema = z.object({
  key: z.string().min(1),
});
export type JiraIssueGetArgs = z.infer<typeof JiraIssueGetArgsSchema>;

export const JiraStatusesArgsSchema = z.object({
  project_key: z.string().optional(),
});
export type JiraStatusesArgs = z.infer<typeof JiraStatusesArgsSchema>;

export const JiraUsersSearchArgsSchema = z.object({
  query: z.string(),
  project_key: z.string().optional(),
  max_results: z.number().int().positive().max(50).optional(),
});
export type JiraUsersSearchArgs = z.infer<typeof JiraUsersSearchArgsSchema>;

// ---------- Write actions ----------

export const JiraCommentArgsSchema = z.object({
  key: z.string().min(1),
  body: z.string().min(1),
  mentioned_account_ids: z.array(z.string()).optional(),
});
export type JiraCommentArgs = z.infer<typeof JiraCommentArgsSchema>;

export const JiraTransitionArgsSchema = z.object({
  key: z.string().min(1),
  transition_id: z.string().min(1),
});
export type JiraTransitionArgs = z.infer<typeof JiraTransitionArgsSchema>;

export const JiraAssignArgsSchema = z.object({
  key: z.string().min(1),
  account_id: z.string().nullable(),
});
export type JiraAssignArgs = z.infer<typeof JiraAssignArgsSchema>;

// ---------- Settings ----------

export const JIRA_SETTINGS_KEY = "jira";

export const JiraAppSettingsSchema = z.object({
  base_url: z.string().optional(),
  last_tested_at: z.number().int().nonnegative().optional(),
  last_filter: JiraFilterSchema.optional(),
  last_sort: z
    .object({
      field: z.string(),
      direction: z.enum(["asc", "desc"]),
    })
    .optional(),
  tasks_top_tab: z.enum(["general", "jira"]).optional(),
});
export type JiraAppSettings = z.infer<typeof JiraAppSettingsSchema>;
