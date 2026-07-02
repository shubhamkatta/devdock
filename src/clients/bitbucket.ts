import {
  BitbucketPRSchema,
  BitbucketPRListResultSchema,
  BitbucketRepoSchema,
  BitbucketUserSchema,
  BitbucketWorkspaceSchema,
  type BitbucketPR,
  type BitbucketPRListArgs,
  type BitbucketPRListResult,
  type BitbucketPRState,
  type BitbucketRepo,
  type BitbucketUser,
  type BitbucketWorkspace,
} from "../schemas/bitbucket.js";

// ---------- Constants ----------

const API_BASE = "https://api.bitbucket.org/2.0";
const ERROR_BODY_TRUNCATE = 256;
const RETRY_BACKOFF_MS = [250, 500, 1000, 2000];
const MAX_RETRIES = 3;

// ---------- Errors ----------

export class BitbucketApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "BitbucketApiError";
  }
}

// ---------- Public types ----------

export interface BitbucketClientOpts {
  email: string;
  apiToken: string;
  workspace?: string;
  fetch?: typeof globalThis.fetch;
}

// ---------- Client ----------

export class BitbucketClient {
  private readonly authHeader: string;
  private readonly workspace: string | undefined;
  private readonly doFetch: typeof globalThis.fetch;

  constructor(opts: BitbucketClientOpts) {
    if (!opts.email || !opts.apiToken) {
      throw new Error(
        "BitbucketClient: email and apiToken are both required.",
      );
    }
    const token = Buffer.from(
      `${opts.email}:${opts.apiToken}`,
      "utf-8",
    ).toString("base64");
    this.authHeader = `Basic ${token}`;
    this.workspace = opts.workspace;
    this.doFetch = opts.fetch ?? globalThis.fetch;
  }

  // ---------- HTTP plumbing ----------

  private async request<T>(
    path: string,
    init: RequestInit = {},
    options: { acceptText?: boolean } = {},
  ): Promise<T> {
    const url = path.startsWith("http") ? path : `${API_BASE}${path}`;

    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const headers = new Headers(init.headers);
      headers.set("Authorization", this.authHeader);
      if (!options.acceptText) {
        headers.set("Accept", "application/json");
      }
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
        throw new BitbucketApiError(
          `Bitbucket ${path} failed: ${resp.status} ${body.slice(0, ERROR_BODY_TRUNCATE)}`,
          resp.status,
        );
      }

      if (resp.status === 204) return null as unknown as T;

      if (options.acceptText) {
        return (await resp.text()) as unknown as T;
      }
      try {
        return (await resp.json()) as T;
      } catch (err) {
        throw new BitbucketApiError(
          `Bitbucket ${path} returned non-JSON: ${err instanceof Error ? err.message : String(err)}`,
          resp.status,
        );
      }
    }

    throw lastErr ?? new BitbucketApiError(`Bitbucket ${path} retries exhausted`, 429);
  }

  // ---------- Endpoints ----------

  async getCurrentUser(): Promise<BitbucketUser> {
    const raw = await this.request<RawBitbucketUser>("/user");
    return BitbucketUserSchema.parse(mapUser(raw));
  }

  async listWorkspaces(): Promise<BitbucketWorkspace[]> {
    const collected: RawBitbucketWorkspace[] = [];
    let next: string | null = `/user/workspaces?pagelen=100`;
    let page = 0;
    const MAX_PAGES = 10;
    while (next !== null && page < MAX_PAGES) {
      const raw: RawPaginated<RawBitbucketWorkspaceAccess> =
        await this.request<RawPaginated<RawBitbucketWorkspaceAccess>>(next);
      for (const row of raw.values ?? []) {
        if (row.workspace !== undefined) collected.push(row.workspace);
      }
      next =
        typeof raw.next === "string" && raw.next.length > 0 ? raw.next : null;
      page++;
    }
    return collected
      .map((w) =>
        BitbucketWorkspaceSchema.parse({
          slug: typeof w.slug === "string" ? w.slug : "",
          name: typeof w.name === "string" ? w.name : (w.slug ?? ""),
          ...(typeof w.uuid === "string" ? { uuid: w.uuid } : {}),
        }),
      )
      .filter((w) => w.slug.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async listRepos(workspace?: string): Promise<BitbucketRepo[]> {
    const ws = workspace ?? this.workspace;
    if (ws === undefined || ws.length === 0) {
      throw new Error("listRepos: workspace is required (none configured)");
    }
    const collected: RawBitbucketRepo[] = [];
    let next: string | null = `/repositories/${encodeURIComponent(ws)}?pagelen=100&role=member`;
    let page = 0;
    const MAX_PAGES = 50;
    while (next !== null && page < MAX_PAGES) {
      const raw: RawPaginated<RawBitbucketRepo> = await this.request<
        RawPaginated<RawBitbucketRepo>
      >(next);
      collected.push(...(raw.values ?? []));
      next = typeof raw.next === "string" && raw.next.length > 0 ? raw.next : null;
      page++;
    }
    return collected.map((r) => BitbucketRepoSchema.parse(mapRepo(r, ws)));
  }

  async getRepo(
    workspace: string,
    repoSlug: string,
  ): Promise<{
    full_name: string;
    default_branch: string;
    clone_ssh: string | null;
    clone_https: string | null;
    web_url: string;
  }> {
    const raw = await this.request<RawBitbucketRepo>(
      `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}`,
    );
    const cloneHttps = (raw.links?.clone ?? []).find((c) => c.name === "https")
      ?.href;
    const cloneSsh = (raw.links?.clone ?? []).find((c) => c.name === "ssh")
      ?.href;
    return {
      full_name:
        typeof raw.full_name === "string"
          ? raw.full_name
          : `${workspace}/${repoSlug}`,
      default_branch:
        typeof raw.mainbranch?.name === "string" ? raw.mainbranch.name : "main",
      clone_https: typeof cloneHttps === "string" ? cloneHttps : null,
      clone_ssh: typeof cloneSsh === "string" ? cloneSsh : null,
      web_url:
        typeof raw.links?.html?.href === "string" ? raw.links.html.href : "",
    };
  }

  async createPullRequest(
    workspace: string,
    repoSlug: string,
    args: {
      title: string;
      description?: string;
      source_branch: string;
      destination_branch: string;
    },
  ): Promise<{ id: number; web_url: string }> {
    const body: Record<string, unknown> = {
      title: args.title,
      source: { branch: { name: args.source_branch } },
      destination: { branch: { name: args.destination_branch } },
    };
    if (args.description !== undefined && args.description.length > 0) {
      body["description"] = args.description;
    }
    const raw = await this.request<{
      id?: number;
      links?: { html?: { href?: string } };
    }>(
      `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/pullrequests`,
      { method: "POST", body: JSON.stringify(body) },
    );
    return {
      id: typeof raw.id === "number" ? raw.id : 0,
      web_url:
        typeof raw.links?.html?.href === "string" ? raw.links.html.href : "",
    };
  }

  async listPullRequests(scope: BitbucketPRListArgs): Promise<BitbucketPRListResult> {
    const ws = scope.workspace ?? this.workspace;
    if (ws === undefined || ws.length === 0) {
      throw new Error("listPullRequests: workspace is required");
    }
    if (scope.repo_slug === undefined || scope.repo_slug.length === 0) {
      throw new Error("listPullRequests: repo_slug is required");
    }
    const params = new URLSearchParams();
    if (scope.state !== undefined) params.set("state", scope.state);
    if (scope.limit !== undefined) {
      params.set("pagelen", String(Math.min(scope.limit, 50)));
    }
    const path = `/repositories/${encodeURIComponent(ws)}/${encodeURIComponent(scope.repo_slug)}/pullrequests${params.toString().length > 0 ? `?${params.toString()}` : ""}`;
    const raw = await this.request<RawPaginated<RawBitbucketPR>>(path);
    const items = (raw.values ?? []).map((p) =>
      BitbucketPRSchema.parse(mapPullRequest(p)),
    );
    return BitbucketPRListResultSchema.parse({
      items,
      next: typeof raw.next === "string" ? raw.next : null,
    });
  }

  async getPullRequest(
    workspace: string,
    repoSlug: string,
    prId: number,
  ): Promise<BitbucketPR> {
    const raw = await this.request<RawBitbucketPR>(
      `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/pullrequests/${prId}`,
    );
    return BitbucketPRSchema.parse(mapPullRequest(raw));
  }

  async getPullRequestDiff(
    workspace: string,
    repoSlug: string,
    prId: number,
  ): Promise<string> {
    return this.request<string>(
      `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/pullrequests/${prId}/diff`,
      {},
      { acceptText: true },
    );
  }

  async approve(workspace: string, repoSlug: string, prId: number): Promise<void> {
    await this.request<unknown>(
      `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/pullrequests/${prId}/approve`,
      { method: "POST" },
    );
  }

  async decline(workspace: string, repoSlug: string, prId: number): Promise<void> {
    await this.request<unknown>(
      `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/pullrequests/${prId}/decline`,
      { method: "POST" },
    );
  }

  async requestChanges(workspace: string, repoSlug: string, prId: number): Promise<void> {
    await this.request<unknown>(
      `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/pullrequests/${prId}/request-changes`,
      { method: "POST" },
    );
  }

  async postInlineComment(
    workspace: string,
    repoSlug: string,
    prId: number,
    args: {
      content: string;
      inline?: { path: string; from?: number; to?: number };
    },
  ): Promise<{ id: string }> {
    const body: Record<string, unknown> = {
      content: { raw: args.content },
    };
    if (args.inline !== undefined) {
      const inline: Record<string, unknown> = { path: args.inline.path };
      if (args.inline.from !== undefined) inline["from"] = args.inline.from;
      if (args.inline.to !== undefined) inline["to"] = args.inline.to;
      body["inline"] = inline;
    }
    const raw = await this.request<{ id?: number }>(
      `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/pullrequests/${prId}/comments`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
    return { id: raw.id !== undefined ? String(raw.id) : "" };
  }
}

// ---------- Mappers ----------

interface RawBitbucketUser {
  uuid?: string;
  account_id?: string;
  display_name?: string;
  nickname?: string;
  links?: { avatar?: { href?: string } };
}

interface RawBitbucketRepo {
  full_name?: string;
  name?: string;
  slug?: string;
  description?: string;
  language?: string;
  mainbranch?: { name?: string };
  links?: { html?: { href?: string }; clone?: Array<{ href?: string; name?: string }> };
  workspace?: { slug?: string };
}

interface RawBitbucketWorkspace {
  slug?: string;
  name?: string;
  uuid?: string;
}

interface RawBitbucketWorkspaceAccess {
  type?: string;
  administrator?: boolean;
  workspace?: RawBitbucketWorkspace;
}

interface RawBitbucketPR {
  id?: number;
  title?: string;
  state?: string;
  created_on?: string;
  updated_on?: string;
  author?: RawBitbucketUser;
  source?: { branch?: { name?: string }; commit?: { hash?: string } };
  destination?: {
    branch?: { name?: string };
    repository?: {
      full_name?: string;
      name?: string;
      slug?: string;
      workspace?: { slug?: string };
    };
  };
  links?: { html?: { href?: string } };
}

interface RawPaginated<T> {
  values?: T[];
  next?: string;
  page?: number;
  pagelen?: number;
  size?: number;
}

function mapUser(raw: RawBitbucketUser): BitbucketUser {
  const out: BitbucketUser = {
    account_id: raw.account_id ?? raw.uuid ?? "",
    display_name: raw.display_name ?? raw.nickname ?? "Unknown",
  };
  const avatar = raw.links?.avatar?.href;
  if (typeof avatar === "string" && avatar.length > 0) out.avatar_url = avatar;
  return out;
}

function mapRepo(raw: RawBitbucketRepo, defaultWorkspace: string): BitbucketRepo {
  const workspace = raw.workspace?.slug ?? defaultWorkspace;
  const slug = raw.slug ?? raw.name ?? "";
  const fullName = raw.full_name ?? `${workspace}/${slug}`;
  const cloneHttps = (raw.links?.clone ?? []).find((c) => c.name === "https")?.href;
  return {
    full_name: fullName,
    slug,
    workspace,
    default_branch: raw.mainbranch?.name ?? "main",
    language: raw.language && raw.language.length > 0 ? raw.language : null,
    description:
      raw.description && raw.description.length > 0 ? raw.description : null,
    clone_url: typeof cloneHttps === "string" ? cloneHttps : null,
    web_url:
      typeof raw.links?.html?.href === "string"
        ? raw.links.html.href
        : `https://bitbucket.org/${workspace}/${slug}`,
  };
}

function mapPullRequest(raw: RawBitbucketPR): BitbucketPR {
  const state = (raw.state ?? "OPEN") as BitbucketPRState;
  const destRepo = raw.destination?.repository ?? {};
  const workspace = destRepo.workspace?.slug ?? "";
  const slug = destRepo.slug ?? destRepo.name ?? "";
  const fullName = destRepo.full_name ?? `${workspace}/${slug}`;
  return {
    id: raw.id ?? 0,
    title: raw.title ?? "",
    source_branch: raw.source?.branch?.name ?? "",
    target_branch: raw.destination?.branch?.name ?? "",
    author: raw.author ? mapUser(raw.author) : { account_id: "", display_name: "Unknown" },
    state,
    created_on: raw.created_on ?? "",
    updated_on: raw.updated_on ?? "",
    repository: { full_name: fullName, slug, workspace },
    head_sha: raw.source?.commit?.hash ?? "",
    web_url:
      typeof raw.links?.html?.href === "string"
        ? raw.links.html.href
        : `https://bitbucket.org/${workspace}/${slug}/pull-requests/${raw.id ?? 0}`,
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
