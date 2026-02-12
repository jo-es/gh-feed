export interface UserRef {
  login: string;
}

export interface IssueComment {
  id: number;
  body: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  user: UserRef | null;
  is_pr_description?: boolean;
}

export interface ReviewComment {
  id: number;
  body: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  user: UserRef | null;
  path: string | null;
  line: number | null;
  original_line: number | null;
  pull_request_review_id?: number | null;
  in_reply_to_id?: number | null;
}

export type CommentTargetKind = "discussion" | "inline" | "review";

export interface SubmitCommentTarget {
  kind: CommentTargetKind;
  id: number;
  author: string;
  htmlUrl: string;
}

export interface SubmitCommentRequest {
  mode: "top-level" | "reply";
  body: string;
  target?: SubmitCommentTarget;
}

export interface PullRequestReview {
  id: number;
  body: string;
  html_url: string;
  state: string;
  submitted_at: string | null;
  user: UserRef | null;
}

export interface IssueResource {
  id: number;
  body: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  user: UserRef | null;
}

export interface PrIdentity {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
}

export interface PrListItem extends PrIdentity {
  updatedAt: string;
  state: string;
}

export interface RepoIdentity {
  owner: string;
  repo: string;
  nameWithOwner: string;
}

export interface InlineCommentNode {
  comment: ReviewComment;
  children: InlineCommentNode[];
}

export interface InlineThread {
  root: InlineCommentNode;
}

export interface LoadedPrComments {
  repo: RepoIdentity;
  pr: PrIdentity;
  prInference: string;
  issueComments: IssueComment[];
  reviewComments: ReviewComment[];
  inlineThreads: InlineThread[];
  reviews: PullRequestReview[];
}

export interface CliOptions {
  prNumber?: number;
  repoOverride?: string;
}
