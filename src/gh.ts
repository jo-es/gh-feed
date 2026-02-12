import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildInlineThreads } from "./model.js";
import type {
  AiReviewEvent,
  CliOptions,
  IssueComment,
  IssueResource,
  LoadedPrComments,
  PrIdentity,
  PrListItem,
  PullRequestReview,
  RepoIdentity,
  ReviewComment,
  SubmitCommentRequest
} from "./types.js";

const execFileAsync = promisify(execFile);
const PR_FIELDS = "number,title,url,headRefName,baseRefName";
const PR_LIST_FIELDS = `${PR_FIELDS},updatedAt,state`;

interface TimelineEvent {
  event: string;
  created_at: string;
  actor: { login: string } | null;
  requested_reviewer?: { login: string } | null;
}

interface ReviewTimelineQueryResponse {
  data?: {
    repository?: {
      pullRequest?: {
        timelineItems?: {
          nodes?: Array<{
            __typename: string;
            createdAt?: string | null;
            actor?: { login: string } | null;
            requestedReviewer?: { __typename?: string; login?: string | null } | null;
          } | null> | null;
        } | null;
      } | null;
    } | null;
  };
}

interface ReviewTimelineGraphqlNode {
  __typename: string;
  createdAt?: string | null;
  actor?: { login: string } | null;
  requestedReviewer?: { __typename?: string; login?: string | null } | null;
}

interface RequestedReviewersResponse {
  users?: Array<{ login?: string | null }>;
}

async function run(
  bin: string,
  args: string[],
  options: { allowFailure?: boolean } = {}
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(bin, args, { maxBuffer: 1024 * 1024 * 64 });
    return stdout.trim();
  } catch (error) {
    if (options.allowFailure) {
      return "";
    }

    const err = error as { stderr?: string; message?: string };
    const detail = err.stderr?.trim() || err.message || "unknown error";
    throw new Error(`${bin} ${args.join(" ")} failed: ${detail}`);
  }
}

function parseJson<T>(raw: string, context: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`Could not parse JSON for ${context}: ${(error as Error).message}`);
  }
}

function parseRepoInput(repoInput: string): RepoIdentity {
  const cleaned = repoInput.trim();
  const parts = cleaned.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid --repo value "${repoInput}". Expected "owner/repo".`);
  }

  return {
    owner: parts[0],
    repo: parts[1],
    nameWithOwner: cleaned
  };
}

function parseRepoFromRemoteUrl(remoteUrl: string): RepoIdentity | null {
  const cleaned = remoteUrl.trim();
  if (!cleaned) {
    return null;
  }

  const sshMatch = cleaned.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return parseRepoInput(`${sshMatch[1]}/${sshMatch[2]}`);
  }

  const httpsMatch = cleaned.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return parseRepoInput(`${httpsMatch[1]}/${httpsMatch[2]}`);
  }

  const sshUrlMatch = cleaned.match(/^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshUrlMatch) {
    return parseRepoInput(`${sshUrlMatch[1]}/${sshUrlMatch[2]}`);
  }

  return null;
}

function repoFlag(repoOverride?: string): string[] {
  return repoOverride ? ["--repo", repoOverride] : [];
}

async function ghJson<T>(args: string[]): Promise<T> {
  const output = await run("gh", args);
  return parseJson<T>(output, `gh ${args.join(" ")}`);
}

async function ghPaginatedArray<T>(path: string): Promise<T[]> {
  const output = await run("gh", ["api", "--paginate", "--slurp", path]);
  const pages = parseJson<unknown[]>(output, `gh api --paginate --slurp ${path}`);

  const flat: T[] = [];
  for (const page of pages) {
    if (Array.isArray(page)) {
      flat.push(...(page as T[]));
      continue;
    }

    flat.push(page as T);
  }

  return flat;
}

function isAiReviewerLogin(login: string | null | undefined): boolean {
  if (!login) {
    return false;
  }

  const normalized = login.toLowerCase();
  return normalized.includes("copilot") || normalized.includes("codex");
}

async function resolveRepo(repoOverride?: string): Promise<RepoIdentity> {
  if (repoOverride) {
    return parseRepoInput(repoOverride);
  }

  try {
    const response = await ghJson<{ nameWithOwner: string }>([
      "repo",
      "view",
      "--json",
      "nameWithOwner"
    ]);
    return parseRepoInput(response.nameWithOwner);
  } catch {
    const remote = await run("git", ["remote", "get-url", "origin"], { allowFailure: true });
    const parsed = parseRepoFromRemoteUrl(remote);
    if (parsed) {
      return parsed;
    }

    throw new Error(
      "Could not infer repository. Run inside a cloned GitHub repo or pass --repo owner/repo."
    );
  }
}

function pickNewestPr(items: PrListItem[]): PrListItem | null {
  if (items.length === 0) {
    return null;
  }

  return [...items].sort((a, b) => {
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  })[0];
}

async function resolvePr(options: CliOptions): Promise<{ pr: PrIdentity; inference: string }> {
  const flags = repoFlag(options.repoOverride);

  if (options.prNumber) {
    const pr = await ghJson<PrIdentity>([
      "pr",
      "view",
      String(options.prNumber),
      "--json",
      PR_FIELDS,
      ...flags
    ]);
    return { pr, inference: `Using explicit PR number #${options.prNumber}.` };
  }

  try {
    const pr = await ghJson<PrIdentity>(["pr", "view", "--json", PR_FIELDS, ...flags]);
    return { pr, inference: "Inferred from current branch via `gh pr view`." };
  } catch {
    // Continue with fallbacks.
  }

  const currentBranch = await run("git", ["branch", "--show-current"], { allowFailure: true });
  if (currentBranch) {
    const branchMatches = await ghJson<PrListItem[]>([
      "pr",
      "list",
      "--state",
      "open",
      "--head",
      currentBranch,
      "--limit",
      "30",
      "--json",
      PR_LIST_FIELDS,
      ...flags
    ]);

    const branchMatch = pickNewestPr(branchMatches);
    if (branchMatch) {
      return {
        pr: branchMatch,
        inference: `No direct branch-linked PR; selected most recently updated open PR for branch "${currentBranch}".`
      };
    }

    const branchAnyState = await ghJson<PrListItem[]>([
      "pr",
      "list",
      "--state",
      "all",
      "--head",
      currentBranch,
      "--limit",
      "30",
      "--json",
      PR_LIST_FIELDS,
      ...flags
    ]);

    const branchAny = pickNewestPr(branchAnyState);
    if (branchAny) {
      return {
        pr: branchAny,
        inference: `No open PR found for branch "${currentBranch}". Selected most recently updated ${branchAny.state.toLowerCase()} PR for that branch.`
      };
    }
  }

  const openPrs = await ghJson<PrListItem[]>([
    "pr",
    "list",
    "--state",
    "open",
    "--limit",
    "30",
    "--json",
    PR_LIST_FIELDS,
    ...flags
  ]);

  const best = pickNewestPr(openPrs);
  if (best && openPrs.length === 1) {
    return { pr: best, inference: "Single open PR found and selected automatically." };
  }

  if (best && openPrs.length > 1) {
    return {
      pr: best,
      inference:
        "Multiple open PRs found. Selected the most recently updated one. Pass --pr to override."
    };
  }

  const anyState = await ghJson<PrListItem[]>([
    "pr",
    "list",
    "--state",
    "all",
    "--limit",
    "30",
    "--json",
    PR_LIST_FIELDS,
    ...flags
  ]);

  const newestAny = pickNewestPr(anyState);
  if (newestAny) {
    return {
      pr: newestAny,
      inference: `No open PRs found. Selected most recently updated ${newestAny.state.toLowerCase()} PR. Pass --pr to override.`
    };
  }

  throw new Error("Could not infer a pull request. Provide one with --pr <number>.");
}

function normalizeIssueComments(input: IssueComment[]): IssueComment[] {
  return [...input].sort((a, b) => {
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}

function normalizeReviewComments(input: ReviewComment[]): ReviewComment[] {
  return [...input].sort((a, b) => {
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}

function normalizeReviews(input: PullRequestReview[]): PullRequestReview[] {
  return [...input].sort((a, b) => {
    const aTime = a.submitted_at ? new Date(a.submitted_at).getTime() : 0;
    const bTime = b.submitted_at ? new Date(b.submitted_at).getTime() : 0;
    return bTime - aTime;
  });
}

function mapTimelineGraphqlNodeToEvent(
  node: ReviewTimelineGraphqlNode | null
): TimelineEvent | null {
  if (!node || !node.createdAt) {
    return null;
  }

  if (node.__typename !== "ReviewRequestedEvent" && node.__typename !== "ReviewRequestRemovedEvent") {
    return null;
  }

  return {
    event: node.__typename === "ReviewRequestedEvent" ? "review_requested" : "review_request_removed",
    created_at: node.createdAt,
    actor: node.actor || null,
    requested_reviewer: node.requestedReviewer?.login ? { login: node.requestedReviewer.login } : null
  };
}

async function loadTimelineEvents(repo: RepoIdentity, prNumber: number): Promise<TimelineEvent[]> {
  try {
    return await ghPaginatedArray<TimelineEvent>(`repos/${repo.owner}/${repo.repo}/issues/${prNumber}/timeline`);
  } catch {
    // Some hosts/configurations reject the REST timeline endpoint. Fall back to GraphQL.
    const query = [
      "query($owner:String!,$repo:String!,$number:Int!){",
      "repository(owner:$owner,name:$repo){",
      "pullRequest(number:$number){",
      "timelineItems(first:250,itemTypes:[REVIEW_REQUESTED_EVENT,REVIEW_REQUEST_REMOVED_EVENT]){",
      "nodes{",
      "__typename",
      "... on ReviewRequestedEvent { createdAt actor { login } requestedReviewer { __typename ... on User { login } ... on Bot { login } } }",
      "... on ReviewRequestRemovedEvent { createdAt actor { login } requestedReviewer { __typename ... on User { login } ... on Bot { login } } }",
      "}",
      "}",
      "}",
      "}",
      "}"
    ].join(" ");

    const raw = await run(
      "gh",
      [
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-f",
        `owner=${repo.owner}`,
        "-f",
        `repo=${repo.repo}`,
        "-F",
        `number=${prNumber}`
      ],
      { allowFailure: true }
    );

    if (!raw) {
      return [];
    }

    const parsed = parseJson<ReviewTimelineQueryResponse>(raw, "gh api graphql review timeline");
    const nodes = parsed.data?.repository?.pullRequest?.timelineItems?.nodes || [];
    return nodes
      .map((node) => mapTimelineGraphqlNodeToEvent(node as ReviewTimelineGraphqlNode | null))
      .filter((event): event is TimelineEvent => Boolean(event));
  }
}

function normalizeAiReviewEvents(input: AiReviewEvent[]): AiReviewEvent[] {
  return [...input].sort((a, b) => {
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

function buildAiReviewEvents(options: {
  timelineEvents: TimelineEvent[];
  reviews: PullRequestReview[];
}): AiReviewEvent[] {
  const events: AiReviewEvent[] = [];
  const requestedCounters = new Map<string, number>();

  for (const event of options.timelineEvents) {
    if (event.event !== "review_requested" && event.event !== "review_request_removed") {
      continue;
    }

    const reviewerLogin = event.requested_reviewer?.login || null;
    if (!reviewerLogin || !isAiReviewerLogin(reviewerLogin)) {
      continue;
    }

    const counterKey = `${event.event}:${event.created_at}:${reviewerLogin}`;
    const nextCounter = (requestedCounters.get(counterKey) || 0) + 1;
    requestedCounters.set(counterKey, nextCounter);

    events.push({
      id: `timeline-${counterKey}:${nextCounter}`,
      action: event.event === "review_requested" ? "requested" : "request_removed",
      reviewerLogin,
      actorLogin: event.actor?.login || null,
      reviewState: null,
      createdAt: event.created_at,
      htmlUrl: ""
    });
  }

  for (const review of options.reviews) {
    const reviewerLogin = review.user?.login || null;
    if (!reviewerLogin || !isAiReviewerLogin(reviewerLogin) || !review.submitted_at) {
      continue;
    }

    events.push({
      id: `review-${review.id}`,
      action: "submitted",
      reviewerLogin,
      actorLogin: reviewerLogin,
      reviewState: review.state || null,
      createdAt: review.submitted_at,
      htmlUrl: review.html_url || ""
    });
  }

  return normalizeAiReviewEvents(events);
}

async function ensureCopilotReviewExtension(): Promise<void> {
  const helpOutput = await run("gh", ["copilot-review", "--help"], { allowFailure: true });
  if (helpOutput) {
    return;
  }

  await run("gh", ["extension", "install", "ChrisCarini/gh-copilot-review"]);
}

function hasCopilotReviewer(response: RequestedReviewersResponse): boolean {
  const users = response.users || [];
  return users.some((user) => {
    const login = (user.login || "").toLowerCase();
    return login.includes("copilot-pull-request-reviewer") || login.includes("copilot");
  });
}

async function isCopilotRequested(options: {
  repo: RepoIdentity;
  prNumber: number;
}): Promise<boolean> {
  const response = await ghJson<RequestedReviewersResponse>([
    "api",
    `repos/${options.repo.owner}/${options.repo.repo}/pulls/${options.prNumber}/requested_reviewers`
  ]);
  return hasCopilotReviewer(response);
}

export async function requestCopilotPrReview(options: {
  repo: RepoIdentity;
  prNumber: number;
}): Promise<void> {
  await ensureCopilotReviewExtension();

  const prUrl = `https://github.com/${options.repo.nameWithOwner}/pull/${options.prNumber}`;
  let extensionError: string | null = null;
  try {
    await run("gh", ["copilot-review", prUrl]);
  } catch (error) {
    extensionError = error instanceof Error ? error.message : String(error);
  }

  if (await isCopilotRequested(options)) {
    return;
  }

  await run(
    "gh",
    [
      "api",
      "--method",
      "POST",
      `repos/${options.repo.owner}/${options.repo.repo}/pulls/${options.prNumber}/requested_reviewers`,
      "-f",
      "reviewers[]=copilot-pull-request-reviewer[bot]"
    ],
    { allowFailure: true }
  );

  if (await isCopilotRequested(options)) {
    return;
  }

  if (extensionError) {
    throw new Error(
      `Could not request Copilot review via extension or REST API. Extension error: ${extensionError}`
    );
  }

  throw new Error("Could not verify Copilot as a requested reviewer after request attempt.");
}

export async function loadPrComments(options: CliOptions): Promise<LoadedPrComments> {
  const repoPromise = resolveRepo(options.repoOverride);
  const prResolutionPromise = options.repoOverride
    ? resolvePr(options)
    : repoPromise.then((repo) =>
        resolvePr({
          ...options,
          repoOverride: repo.nameWithOwner
        })
      );
  const [repo, { pr, inference }] = await Promise.all([repoPromise, prResolutionPromise]);

  const [issueResource, issueCommentsRaw, reviewCommentsRaw, reviewsRaw, timelineEventsRaw] = await Promise.all([
    ghJson<IssueResource>(["api", `repos/${repo.owner}/${repo.repo}/issues/${pr.number}`]),
    ghPaginatedArray<IssueComment>(`repos/${repo.owner}/${repo.repo}/issues/${pr.number}/comments`),
    ghPaginatedArray<ReviewComment>(`repos/${repo.owner}/${repo.repo}/pulls/${pr.number}/comments`),
    ghPaginatedArray<PullRequestReview>(`repos/${repo.owner}/${repo.repo}/pulls/${pr.number}/reviews`),
    loadTimelineEvents(repo, pr.number)
  ]);

  const prDescription: IssueComment = {
    id: issueResource.id,
    body: issueResource.body || "",
    html_url: `${pr.url}#issue-${issueResource.id}`,
    created_at: issueResource.created_at,
    updated_at: issueResource.updated_at,
    user: issueResource.user,
    is_pr_description: true
  };

  const issueComments = normalizeIssueComments([
    prDescription,
    ...issueCommentsRaw.map((comment) => ({ ...comment, is_pr_description: false }))
  ]);
  const reviewComments = normalizeReviewComments(reviewCommentsRaw);
  const reviews = normalizeReviews(reviewsRaw);
  const inlineThreads = buildInlineThreads(reviewComments);
  const aiReviewEvents = buildAiReviewEvents({
    timelineEvents: timelineEventsRaw,
    reviews
  });

  return {
    repo,
    pr,
    prInference: inference,
    issueComments,
    reviewComments,
    inlineThreads,
    reviews,
    aiReviewEvents
  };
}

function buildReplyFallbackBody(request: SubmitCommentRequest): string {
  const body = request.body.trim();
  if (request.mode !== "reply" || !request.target) {
    return body;
  }

  const author = request.target.author ? ` @${request.target.author}` : "";
  return `_Replying to${author}:_ <${request.target.htmlUrl}>\n\n${body}`;
}

export async function submitPrComment(options: {
  repo: RepoIdentity;
  prNumber: number;
  request: SubmitCommentRequest;
}): Promise<void> {
  const body = options.request.body.trim();
  if (!body) {
    throw new Error("Comment body cannot be empty.");
  }

  const { repo, prNumber, request } = options;
  if (request.mode === "reply" && !request.target) {
    throw new Error("Reply target is required when mode is \"reply\".");
  }

  if (request.mode === "reply" && request.target?.kind === "inline") {
    await run("gh", [
      "api",
      "-X",
      "POST",
      `repos/${repo.owner}/${repo.repo}/pulls/${prNumber}/comments/${request.target.id}/replies`,
      "-f",
      `body=${body}`
    ]);
    return;
  }

  const finalBody = buildReplyFallbackBody(request);
  await run("gh", [
    "api",
    "-X",
    "POST",
    `repos/${repo.owner}/${repo.repo}/issues/${prNumber}/comments`,
    "-f",
    `body=${finalBody}`
  ]);
}

export async function listOpenPrs(options: CliOptions): Promise<{
  repo: RepoIdentity;
  prs: PrListItem[];
}> {
  const repo = await resolveRepo(options.repoOverride);
  const prs = await ghJson<PrListItem[]>([
    "pr",
    "list",
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    PR_LIST_FIELDS,
    "--repo",
    repo.nameWithOwner
  ]);

  const ordered = [...prs].sort((a, b) => {
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  return {
    repo,
    prs: ordered
  };
}
