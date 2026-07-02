import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { JiraClient } from "./clients/jira.js";
import type { JiraSearchArgs } from "./schemas/jira.js";

export interface DevdockMcpOpts {
  jira: {
    baseUrl: string;
    email: string;
    apiToken: string;
  };
}

export function createMcpServer(opts: DevdockMcpOpts): McpServer {
  const server = new McpServer({
    name: "devdock",
    version: "1.0.0",
  });

  const jira = new JiraClient({
    baseUrl: opts.jira.baseUrl,
    email: opts.jira.email,
    apiToken: opts.jira.apiToken,
  });

  // ── jira_search ──────────────────────────────────────────────

  server.tool(
    "jira_search",
    "Search JIRA issues using filters. Supports project keys, statuses, priorities, issue types (Epic, Story, Task, Subtask, Bug), assignees, date ranges, and free text. Returns issue summaries.",
    {
      project_keys: z.array(z.string()).optional().describe("Filter by project keys, e.g. [\"ENG\", \"PLAT\"]"),
      statuses: z.array(z.string()).optional().describe("Filter by status names, e.g. [\"In Progress\", \"In Review\"]"),
      status_not: z.boolean().optional().describe("If true, exclude the listed statuses instead of including them"),
      priorities: z.array(z.enum(["Highest", "High", "Medium", "Low", "Lowest"])).optional().describe("Filter by priority"),
      issue_types: z.array(z.string()).optional().describe("Filter by issue type: Epic, Story, Task, Subtask, Bug, Incident, etc."),
      assignees: z.array(z.string()).optional().describe("Filter by assignee display names or account IDs. Use \"__me\" for the authenticated user"),
      created_after: z.string().optional().describe("ISO date string — only issues created after this date"),
      created_before: z.string().optional().describe("ISO date string — only issues created before this date"),
      updated_after: z.string().optional().describe("ISO date string — only issues updated after this date"),
      updated_before: z.string().optional().describe("ISO date string — only issues updated before this date"),
      text: z.string().optional().describe("Free-text search across issue summary and description"),
      sort_field: z.enum(["key", "summary", "priority", "status", "assignee", "created", "updated"]).optional().describe("Field to sort by"),
      sort_direction: z.enum(["asc", "desc"]).optional().describe("Sort direction"),
      limit: z.number().int().positive().max(100).optional().describe("Max results to return (default 50, max 100)"),
    },
    async (params) => {
      const args: JiraSearchArgs = {
        filter: {
          project_keys: params.project_keys,
          statuses: params.statuses,
          status_not: params.status_not,
          priorities: params.priorities,
          issue_types: params.issue_types,
          assignees: params.assignees,
          created_after: params.created_after,
          created_before: params.created_before,
          updated_after: params.updated_after,
          updated_before: params.updated_before,
          text: params.text,
        },
        limit: params.limit ?? 50,
        sort: params.sort_field
          ? { field: params.sort_field, direction: params.sort_direction ?? "desc" }
          : undefined,
      };

      const result = await jira.searchIssues(args);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );

  // ── jira_get_issue ───────────────────────────────────────────

  server.tool(
    "jira_get_issue",
    "Get full details for a single JIRA issue by key. Returns description, comments, available workflow transitions, and a web URL.",
    {
      key: z.string().describe("Issue key, e.g. \"ENG-1234\""),
    },
    async (params) => {
      const issue = await jira.getIssue(params.key);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(issue, null, 2),
        }],
      };
    },
  );

  // ── jira_list_projects ───────────────────────────────────────

  server.tool(
    "jira_list_projects",
    "List all JIRA projects accessible to the authenticated user. Returns project keys, names, and types.",
    {},
    async () => {
      const projects = await jira.getProjects();
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(projects, null, 2),
        }],
      };
    },
  );

  // ── jira_list_statuses ───────────────────────────────────────

  server.tool(
    "jira_list_statuses",
    "List available statuses, optionally scoped to a project. Useful for discovering valid status names before searching.",
    {
      project_key: z.string().optional().describe("Scope to a specific project, e.g. \"ENG\""),
    },
    async (params) => {
      const statuses = await jira.getStatuses(params.project_key);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(statuses, null, 2),
        }],
      };
    },
  );

  // ── jira_get_transitions ─────────────────────────────────────

  server.tool(
    "jira_get_transitions",
    "Get available workflow transitions for a JIRA issue. Use this to discover valid transition IDs before transitioning an issue.",
    {
      key: z.string().describe("Issue key, e.g. \"ENG-1234\""),
    },
    async (params) => {
      const transitions = await jira.getTransitions(params.key);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(transitions, null, 2),
        }],
      };
    },
  );

  // ── jira_comment ─────────────────────────────────────────────

  server.tool(
    "jira_comment",
    "Add a comment to a JIRA issue. Supports @-mentions using @[Display Name] syntax with account IDs.",
    {
      key: z.string().describe("Issue key, e.g. \"ENG-1234\""),
      body: z.string().describe("Comment text. Use @[Display Name] for mentions"),
      mentioned_account_ids: z.array(z.string()).optional().describe("Atlassian account IDs for each @[...] mention in order"),
    },
    async (params) => {
      const comment = await jira.commentIssue({
        key: params.key,
        body: params.body,
        mentioned_account_ids: params.mentioned_account_ids,
      });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(comment, null, 2),
        }],
      };
    },
  );

  // ── jira_transition ──────────────────────────────────────────

  server.tool(
    "jira_transition",
    "Transition a JIRA issue through its workflow (e.g. To Do → In Progress → Done). Call jira_get_transitions first to discover valid transition IDs.",
    {
      key: z.string().describe("Issue key, e.g. \"ENG-1234\""),
      transition_id: z.string().describe("Transition ID from jira_get_transitions"),
    },
    async (params) => {
      await jira.transitionIssue({
        key: params.key,
        transition_id: params.transition_id,
      });
      return {
        content: [{
          type: "text" as const,
          text: `Issue ${params.key} transitioned successfully.`,
        }],
      };
    },
  );

  // ── jira_assign ──────────────────────────────────────────────

  server.tool(
    "jira_assign",
    "Assign a JIRA issue to a user, or unassign it by passing null. Use jira_search_users to find account IDs.",
    {
      key: z.string().describe("Issue key, e.g. \"ENG-1234\""),
      account_id: z.string().nullable().describe("Atlassian account ID of the assignee, or null to unassign"),
    },
    async (params) => {
      await jira.assignIssue({
        key: params.key,
        account_id: params.account_id,
      });
      const action = params.account_id ? "assigned" : "unassigned";
      return {
        content: [{
          type: "text" as const,
          text: `Issue ${params.key} ${action} successfully.`,
        }],
      };
    },
  );

  // ── jira_search_users ────────────────────────────────────────

  server.tool(
    "jira_search_users",
    "Search for JIRA users by name or email. Returns account IDs needed for assignment and @-mentions.",
    {
      query: z.string().describe("Search query — name or email fragment"),
      project_key: z.string().optional().describe("Scope to users in a specific project"),
      max_results: z.number().int().positive().max(50).optional().describe("Max results (default 10)"),
    },
    async (params) => {
      const users = await jira.searchUsers({
        query: params.query,
        project_key: params.project_key,
        max_results: params.max_results,
      });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(users, null, 2),
        }],
      };
    },
  );

  return server;
}
