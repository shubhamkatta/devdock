export { JiraClient, JiraApiError, textToAdf } from "./clients/jira.js";
export type { JiraClientOpts } from "./clients/jira.js";

export { BitbucketClient, BitbucketApiError } from "./clients/bitbucket.js";
export type { BitbucketClientOpts } from "./clients/bitbucket.js";

export {
  cloneRepoWithSsh,
  cloneRepoHttps,
  fetchAllWithSsh,
  pushBranchWithSsh,
  initRepo,
  setRemoteOrigin,
  currentBranch,
  workingTreeStatus,
  checkoutNewBranch,
  stageAllAndCommit,
  stageAll,
  defaultRemoteBranch,
  runGitPlain,
} from "./scm-ops.js";
export type { GitRunResult, CloneOpts, FetchOpts, PushOpts, CloneHttpsOpts } from "./scm-ops.js";

export * from "./schemas/index.js";
