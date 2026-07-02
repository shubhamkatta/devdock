import {
  JiraCommentSchema,
  JiraIssueSchema,
  JiraIssueSummarySchema,
  JiraPrioritySchema,
  JiraProjectSchema,
  JiraSearchResultSchema,
  JiraTransitionSchema,
  JiraUserSchema,
  type JiraAssignArgs,
  type JiraComment,
  type JiraCommentArgs,
  type JiraIssue,
  type JiraIssueSummary,
  type JiraPriority,
  type JiraProject,
  type JiraSearchArgs,
  type JiraSearchResult,
  type JiraTransition,
  type JiraTransitionArgs,
  type JiraUser,
  type JiraUsersSearchArgs,
} from "../schemas/jira.js";

// ---------- Constants ----------

const API_BASE = "/rest/api/3";
const ERROR_BODY_TRUNCATE = 256;
const RETRY_BACKOFF_MS = [250, 500, 1000, 2000];
const MAX_RETRIES = 3;

const DEFAULT_FIELDS = [
  "summary",
  "status",
  "priority",
  "issuetype",
  "assignee",
  "reporter",
  "created",
  "updated",
  "project",
  "labels",
];

const SORT_FIELD_MAP: Record<string, string> = {
  key: "issuekey",
  summary: "summary",
  priority: "priority",
  status: "status",
  assignee: "assignee",
  created: "created",
  updated: "updated",
};

const STATUS_CATEGORY_MAP: Record<string, "new" | "indeterminate" | "done" | "unknown"> = {
  new: "new",
  indeterminate: "indeterminate",
  done: "done",
  undefined: "unknown",
};

const KNOWN_PRIORITIES: ReadonlySet<JiraPriority> = new Set<JiraPriority>([
  "Highest",
  "High",
  "Medium",
  "Low",
  "Lowest",
  "Unknown",
]);

// ---------- Errors ----------

export class JiraApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "JiraApiError";
  }
}

// ---------- Public types ----------

export interface JiraClientOpts {
  baseUrl: string;
  email: string;
  apiToken: string;
  fetch?: typeof globalThis.fetch;
}

// ---------- Client ----------

export class JiraClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly doFetch: typeof globalThis.fetch;

  constructor(opts: JiraClientOpts) {
    if (!opts.baseUrl || !opts.email || !opts.apiToken) {
      throw new Error(
        "JiraClient: baseUrl, email, and apiToken are all required.",
      );
    }
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    const token = Buffer.from(
      `${opts.email}:${opts.apiToken}`,
      "utf-8",
    ).toString("base64");
    this.authHeader = `Basic ${token}`;
    this.doFetch = opts.fetch ?? globalThis.fetch;
  }

  // ---------- HTTP plumbing ----------

  private async request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const url = path.startsWith("http")
      ? path
      : `${this.baseUrl}${API_BASE}${path}`;

    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const headers = new Headers(init.headers);
      headers.set("Authorization", this.authHeader);
      headers.set("Accept", "application/json");
      if (init.body && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }

      let resp: Response;
      try {
        resp = await this.doFetch(url, { ...init, headers });
      } catch (err) {
        lastErr = err;
        throw err;
      }

      if (resp.status === 429 && attempt < MAX_RETRIES) {
        const backoff = RETRY_BACKOFF_MS[attempt] ?? 2000;
        await sleep(backoff);
        continue;
      }

      if (!resp.ok) {
        const body = await safeReadText(resp);
        const truncated = body.slice(0, ERROR_BODY_TRUNCATE);
        throw new JiraApiError(
          `JIRA ${path} failed: ${resp.status} ${truncated}`,
          resp.status,
        );
      }

      if (resp.status === 204) return null as unknown as T;

      let parsed: unknown;
      try {
        parsed = await resp.json();
      } catch (err) {
        throw new JiraApiError(
          `JIRA ${path} returned non-JSON: ${err instanceof Error ? err.message : String(err)}`,
          resp.status,
        );
      }
      return parsed as T;
    }

    throw lastErr ?? new JiraApiError(`JIRA ${path} retries exhausted`, 429);
  }

  // ---------- Endpoints ----------

  async getCurrentUser(): Promise<JiraUser> {
    const raw = await this.request<RawAtlassianUser>("/myself");
    return JiraUserSchema.parse(mapUser(raw));
  }

  async getProjects(): Promise<JiraProject[]> {
    const pageSize = 50;
    const collected: RawAtlassianProject[] = [];
    let startAt = 0;
    let isLast = false;
    let page = 0;
    const MAX_PROJECT_PAGES = 200;

    while (!isLast && page < MAX_PROJECT_PAGES) {
      const raw = await this.request<{
        values?: RawAtlassianProject[];
        startAt?: number;
        maxResults?: number;
        total?: number;
        isLast?: boolean;
        nextPage?: string | null;
      }>(
        `/project/search?expand=description&startAt=${startAt}&maxResults=${pageSize}`,
      );
      const values = raw.values ?? [];
      collected.push(...values);

      if (raw.isLast === true) {
        isLast = true;
      } else if (typeof raw.nextPage === "string" && raw.nextPage.length > 0) {
        isLast = false;
      } else if (typeof raw.total === "number") {
        isLast = collected.length >= raw.total;
      } else {
        isLast = values.length < pageSize;
      }

      startAt += values.length || pageSize;
      page += 1;
    }

    return collected.map((p) => JiraProjectSchema.parse(mapProject(p)));
  }

  async getStatuses(projectKey?: string): Promise<string[]> {
    const path = projectKey
      ? `/project/${encodeURIComponent(projectKey)}/statuses`
      : `/status`;
    const raw = await this.request<unknown>(path);
    const names = new Set<string>();
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        const e = entry as { name?: string; statuses?: Array<{ name?: string }> };
        if (typeof e.name === "string") names.add(e.name);
        if (Array.isArray(e.statuses)) {
          for (const s of e.statuses) {
            if (typeof s.name === "string") names.add(s.name);
          }
        }
      }
    }
    return Array.from(names);
  }

  async searchIssues(args: JiraSearchArgs): Promise<JiraSearchResult> {
    const jql = buildJql(args);
    const limit = args.limit ?? 100;
    const pageSize = Math.min(100, limit);

    const collected: RawIssue[] = [];
    let nextPageToken: string | undefined;
    let isLast = false;

    while (!isLast && collected.length < limit) {
      const remaining = limit - collected.length;
      const body: Record<string, unknown> = {
        jql,
        fields: DEFAULT_FIELDS,
        maxResults: Math.min(pageSize, remaining),
      };
      if (nextPageToken !== undefined) body["nextPageToken"] = nextPageToken;
      const raw = await this.request<RawSearchJqlResponse>("/search/jql", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const page = raw.issues ?? [];
      for (const it of page) {
        if (collected.length >= limit) break;
        collected.push(it);
      }
      nextPageToken = raw.nextPageToken ?? undefined;
      isLast = raw.isLast === true || nextPageToken === undefined;
    }

    const issues = collected.map((it) =>
      JiraIssueSummarySchema.parse(mapIssueSummary(it)),
    );
    return JiraSearchResultSchema.parse({
      issues,
      total: issues.length,
      offset: 0,
    });
  }

  async getIssue(key: string): Promise<JiraIssue> {
    const raw = await this.request<RawIssue>(
      `/issue/${encodeURIComponent(key)}?expand=renderedFields,transitions`,
    );
    const summary = mapIssueSummary(raw);
    const rendered = raw.renderedFields ?? {};
    const description_html = typeof rendered.description === "string" && rendered.description.length > 0
      ? rendered.description
      : null;
    const renderedComments = rendered.comment?.comments ?? [];
    const rawComments = raw.fields?.comment?.comments ?? [];
    const comments: JiraComment[] = rawComments.map((c, idx) => {
      const renderedBody = renderedComments[idx]?.body;
      return JiraCommentSchema.parse(
        mapComment(c, typeof renderedBody === "string" ? renderedBody : undefined),
      );
    });
    const transitions: JiraTransition[] = (raw.transitions ?? []).map((t) =>
      JiraTransitionSchema.parse(mapTransition(t)),
    );
    const url = `${this.baseUrl}/browse/${encodeURIComponent(key)}`;
    return JiraIssueSchema.parse({
      ...summary,
      description_html,
      comments,
      transitions,
      url,
    });
  }

  async getTransitions(key: string): Promise<JiraTransition[]> {
    const raw = await this.request<{ transitions?: RawTransition[] }>(
      `/issue/${encodeURIComponent(key)}/transitions?expand=transitions.fields`,
    );
    return (raw.transitions ?? []).map((t) =>
      JiraTransitionSchema.parse(mapTransition(t)),
    );
  }

  async searchUsers(args: JiraUsersSearchArgs): Promise<JiraUser[]> {
    const params = new URLSearchParams({
      query: args.query,
      maxResults: String(args.max_results ?? 10),
    });
    if (args.project_key) {
      params.set("showAvatar", "true");
    }
    const raw = await this.request<{ users?: RawAtlassianUser[] }>(
      `/user/picker?${params.toString()}`,
    );
    return (raw.users ?? []).map((u) => JiraUserSchema.parse(mapUser(u)));
  }

  async commentIssue(args: JiraCommentArgs): Promise<JiraComment> {
    const adf = textToAdf(args.body, args.mentioned_account_ids ?? []);
    const path = `/issue/${encodeURIComponent(args.key)}/comment?expand=renderedBody`;
    const raw = await this.request<RawComment>(path, {
      method: "POST",
      body: JSON.stringify({ body: adf }),
    });
    return JiraCommentSchema.parse(mapComment(raw, raw.renderedBody));
  }

  async transitionIssue(args: JiraTransitionArgs): Promise<void> {
    await this.request<null>(
      `/issue/${encodeURIComponent(args.key)}/transitions`,
      {
        method: "POST",
        body: JSON.stringify({ transition: { id: args.transition_id } }),
      },
    );
  }

  async assignIssue(args: JiraAssignArgs): Promise<void> {
    await this.request<null>(
      `/issue/${encodeURIComponent(args.key)}/assignee`,
      {
        method: "PUT",
        body: JSON.stringify({ accountId: args.account_id }),
      },
    );
  }
}

// ---------- JQL builder ----------

function buildJql(args: JiraSearchArgs): string {
  const f = args.filter;
  const clauses: string[] = [];

  if (f.project_keys && f.project_keys.length > 0) {
    clauses.push(`project IN (${f.project_keys.map(jqlQuote).join(", ")})`);
  }
  if (f.assignees && f.assignees.length > 0) {
    const tokens = f.assignees.map((a) =>
      a === "__me" ? "currentUser()" : jqlQuote(a),
    );
    clauses.push(`assignee IN (${tokens.join(", ")})`);
  }
  if (f.statuses && f.statuses.length > 0) {
    const op = f.status_not ? "NOT IN" : "IN";
    clauses.push(`status ${op} (${f.statuses.map(jqlQuote).join(", ")})`);
  }
  if (f.priorities && f.priorities.length > 0) {
    clauses.push(
      `priority IN (${f.priorities.map(jqlQuote).join(", ")})`,
    );
  }
  if (f.issue_types && f.issue_types.length > 0) {
    clauses.push(
      `issuetype IN (${f.issue_types.map(jqlQuote).join(", ")})`,
    );
  }
  if (f.created_after) {
    clauses.push(`created >= "${dateOnly(f.created_after)}"`);
  }
  if (f.created_before) {
    clauses.push(`created <= "${dateOnly(f.created_before)}"`);
  }
  if (f.updated_after) {
    clauses.push(`updated >= "${dateOnly(f.updated_after)}"`);
  }
  if (f.updated_before) {
    clauses.push(`updated <= "${dateOnly(f.updated_before)}"`);
  }
  if (f.text && f.text.trim().length > 0) {
    clauses.push(`text ~ ${jqlQuote(f.text.trim())}`);
  }

  let jql = clauses.join(" AND ");
  if (args.sort) {
    const field = SORT_FIELD_MAP[args.sort.field] ?? args.sort.field;
    const dir = args.sort.direction === "desc" ? "DESC" : "ASC";
    jql = jql.length > 0 ? `${jql} ORDER BY ${field} ${dir}` : `ORDER BY ${field} ${dir}`;
  }
  return jql;
}

function jqlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function dateOnly(iso: string): string {
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}

// ---------- ADF serializer ----------

interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  text?: string;
  content?: AdfNode[];
}

interface AdfDoc {
  type: "doc";
  version: 1;
  content: AdfNode[];
}

export function textToAdf(text: string, mentionedAccountIds: string[]): AdfDoc {
  const lines = text.split(/\r?\n/);
  const mentionQueue = [...mentionedAccountIds];
  const paragraphs: AdfNode[] = lines.map((line) => ({
    type: "paragraph",
    content: lineToNodes(line, mentionQueue),
  }));
  return { type: "doc", version: 1, content: paragraphs };
}

function lineToNodes(line: string, mentionQueue: string[]): AdfNode[] {
  const nodes: AdfNode[] = [];
  const regex = /@\[([^\]]+)\]/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    if (match.index > cursor) {
      nodes.push({ type: "text", text: line.slice(cursor, match.index) });
    }
    const accountId = mentionQueue.shift();
    const label = match[1] ?? "";
    if (accountId) {
      nodes.push({
        type: "mention",
        attrs: { id: accountId, text: `@${label}` },
      });
    } else {
      nodes.push({ type: "text", text: match[0] });
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < line.length) {
    nodes.push({ type: "text", text: line.slice(cursor) });
  }
  if (nodes.length === 0) {
    nodes.push({ type: "text", text: "" });
  }
  return nodes;
}

// ---------- Mappers ----------

interface RawAtlassianUser {
  accountId?: string;
  displayName?: string;
  emailAddress?: string;
  avatarUrls?: Record<string, string>;
}

interface RawAtlassianProject {
  key?: string;
  name?: string;
  projectTypeKey?: string;
  avatarUrls?: Record<string, string>;
}

interface RawIssueFields {
  summary?: string;
  status?: { name?: string; statusCategory?: { key?: string } };
  priority?: { name?: string };
  issuetype?: { name?: string };
  assignee?: RawAtlassianUser | null;
  reporter?: RawAtlassianUser | null;
  created?: string;
  updated?: string;
  project?: { key?: string };
  labels?: string[];
  comment?: {
    comments?: RawComment[];
  };
}

interface RawIssue {
  id?: string;
  key?: string;
  fields?: RawIssueFields;
  renderedFields?: {
    description?: string;
    comment?: {
      comments?: Array<{ body?: string }>;
    };
  };
  transitions?: RawTransition[];
}

interface RawSearchJqlResponse {
  issues?: RawIssue[];
  nextPageToken?: string | null;
  isLast?: boolean;
}

interface RawComment {
  id?: string;
  author?: RawAtlassianUser;
  body?: unknown;
  renderedBody?: string;
  created?: string;
  updated?: string;
}

interface RawTransition {
  id?: string;
  name?: string;
  to?: { name?: string; statusCategory?: { key?: string } };
}

function mapUser(raw: RawAtlassianUser): JiraUser {
  const obj: JiraUser = {
    account_id: raw.accountId ?? "",
    display_name: raw.displayName ?? "Unknown",
  };
  if (raw.emailAddress) obj.email = raw.emailAddress;
  const avatars = raw.avatarUrls;
  if (avatars) {
    const url = avatars["48x48"] ?? Object.values(avatars)[0];
    if (url) obj.avatar_url = url;
  }
  return obj;
}

function mapProject(raw: RawAtlassianProject): JiraProject {
  const obj: JiraProject = {
    key: raw.key ?? "",
    name: raw.name ?? "Unknown",
  };
  if (raw.projectTypeKey) obj.project_type = raw.projectTypeKey;
  const avatars = raw.avatarUrls;
  if (avatars) {
    const url = avatars["48x48"] ?? Object.values(avatars)[0];
    if (url) obj.avatar_url = url;
  }
  return obj;
}

function mapIssueSummary(raw: RawIssue): JiraIssueSummary {
  const fields = raw.fields ?? {};
  const categoryKey = fields.status?.statusCategory?.key ?? "undefined";
  const status_category = STATUS_CATEGORY_MAP[categoryKey] ?? "unknown";

  const rawPriority = fields.priority?.name ?? "Unknown";
  const priority = coercePriority(rawPriority);

  const assigneeRaw = fields.assignee;
  const reporterRaw = fields.reporter;
  return {
    key: raw.key ?? "",
    id: raw.id ?? "",
    summary: fields.summary ?? "",
    status: fields.status?.name ?? "Unknown",
    status_category,
    priority,
    issue_type: fields.issuetype?.name ?? "Other",
    assignee: assigneeRaw ? mapUser(assigneeRaw) : null,
    reporter: reporterRaw ? mapUser(reporterRaw) : null,
    created: fields.created ?? "",
    updated: fields.updated ?? "",
    project_key: fields.project?.key ?? "",
    labels: fields.labels ?? [],
  };
}

function coercePriority(name: string): JiraPriority {
  if (KNOWN_PRIORITIES.has(name as JiraPriority)) {
    return name as JiraPriority;
  }
  const norm = JiraPrioritySchema.safeParse(name);
  if (norm.success) return norm.data;
  return "Unknown";
}

function mapComment(raw: RawComment, renderedBody?: string): JiraComment {
  const body = renderedBody ?? raw.renderedBody ?? "";
  const author = raw.author ? mapUser(raw.author) : {
    account_id: "",
    display_name: "Unknown",
  };
  const out: JiraComment = {
    id: raw.id ?? "",
    author,
    body_html: typeof body === "string" ? body : "",
    created: raw.created ?? "",
  };
  if (raw.updated) out.updated = raw.updated;
  return out;
}

function mapTransition(raw: RawTransition): JiraTransition {
  const categoryKey = raw.to?.statusCategory?.key ?? "undefined";
  return {
    id: raw.id ?? "",
    name: raw.name ?? "",
    to_status: raw.to?.name ?? "Unknown",
    to_status_category: STATUS_CATEGORY_MAP[categoryKey] ?? "unknown",
  };
}

// ---------- Helpers ----------

async function safeReadText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
