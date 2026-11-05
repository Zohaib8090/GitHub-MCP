// Pull requests, reviews, review comments, requested reviewers.
const RP = "/repos/{owner}/{repo}";
const PR_PICK = ["number", "title", "state", "draft", "user.login", "head.ref", "base.ref", "merged", "mergeable_state", "created_at", "updated_at", "html_url"];
const RC_PICK = ["id", "user.login", "path", "line", "side", "body", "in_reply_to_id", "pull_request_review_id", "created_at", "html_url"];
const EVENT = "e(APPROVE|REQUEST_CHANGES|COMMENT)";

export default {
  pulls: [
    ["gh_list_pulls", `GET ${RP}/pulls`, "List pull requests.", "q.state?:e(open|closed|all) q.head?:s q.base?:s q.sort?:e(created|updated|popularity|long-running) q.direction?:e(asc|desc)", { pick: PR_PICK }],
    ["gh_get_pull", `GET ${RP}/pulls/{pull_number:n}`, "Get one pull request (mergeability, stats, head/base)."],
    ["gh_create_pull", `POST ${RP}/pulls`, "Open a pull request. head may be 'branch' or 'user:branch'.", "b.title:s b.head:s b.base:s b.body?:s b.draft?:b b.maintainer_can_modify?:b b.head_repo?:s"],
    ["gh_update_pull", `PATCH ${RP}/pulls/{pull_number:n}`, "Edit a PR: title, body, base, or close/reopen via state.", "b.title?:s b.body?:s b.state?:e(open|closed) b.base?:s b.maintainer_can_modify?:b"],
    ["gh_merge_pull", `PUT ${RP}/pulls/{pull_number:n}/merge`, "Merge a pull request.", "b.merge_method?:e(merge|squash|rebase) b.commit_title?:s b.commit_message?:s b.sha?:s"],
    ["gh_is_pull_merged", `GET ${RP}/pulls/{pull_number:n}/merge`, "Check whether a PR has been merged (errors with 404 if not)."],
    ["gh_update_pull_branch", `PUT ${RP}/pulls/{pull_number:n}/update-branch`, "Merge the base branch into the PR branch.", "b.expected_head_sha?:s"],
    ["gh_list_pull_files", `GET ${RP}/pulls/{pull_number:n}/files`, "Files changed in a PR (add full=true for patches).", "q.per_page?:n q.page?:n", { pick: ["filename", "status", "additions", "deletions", "changes"] }],
    ["gh_list_pull_commits", `GET ${RP}/pulls/{pull_number:n}/commits`, "Commits in a PR.", "q.per_page?:n q.page?:n", { pick: ["sha", "commit.message", "author.login"] }],
    ["gh_list_pulls_for_commit", `GET ${RP}/commits/{commit_sha}/pulls`, "PRs that contain a commit.", "", { pick: PR_PICK }],

    ["gh_list_reviews", `GET ${RP}/pulls/{pull_number:n}/reviews`, "Reviews on a PR.", "", { pick: ["id", "user.login", "state", "body", "submitted_at", "commit_id"] }],
    ["gh_get_review", `GET ${RP}/pulls/{pull_number:n}/reviews/{review_id:n}`, "Get one review."],
    ["gh_create_review", `POST ${RP}/pulls/{pull_number:n}/reviews`, "Create a review. Omit event to leave it PENDING (add comments, then gh_submit_review). comments: [{path, line, side, body}].", `b.body?:s b.event?:${EVENT} b.commit_id?:s b.comments?:oa`],
    ["gh_submit_review", `POST ${RP}/pulls/{pull_number:n}/reviews/{review_id:n}/events`, "Submit a pending review.", `b.event:${EVENT} b.body?:s`],
    ["gh_update_review", `PUT ${RP}/pulls/{pull_number:n}/reviews/{review_id:n}`, "Edit a pending review's body.", "b.body:s"],
    ["gh_delete_pending_review", `DELETE ${RP}/pulls/{pull_number:n}/reviews/{review_id:n}`, "Delete a pending review.", "", { destructive: true }],
    ["gh_dismiss_review", `PUT ${RP}/pulls/{pull_number:n}/reviews/{review_id:n}/dismissals`, "Dismiss a review.", "b.message:s"],
    ["gh_list_review_comments", `GET ${RP}/pulls/{pull_number:n}/reviews/{review_id:n}/comments`, "Comments that belong to one review.", "", { pick: RC_PICK }],

    ["gh_list_pull_comments", `GET ${RP}/pulls/{pull_number:n}/comments`, "Inline review comments on a PR.", "q.sort?:e(created|updated) q.direction?:e(asc|desc) q.since?:s", { pick: RC_PICK }],
    ["gh_get_pull_comment", `GET ${RP}/pulls/comments/{comment_id:n}`, "Get one inline review comment."],
    ["gh_create_pull_comment", `POST ${RP}/pulls/{pull_number:n}/comments`, "Add an inline comment on a diff line (needs commit_id, path, line).", "b.body:s b.commit_id:s b.path:s b.line?:n b.side?:e(LEFT|RIGHT) b.start_line?:n b.start_side?:e(LEFT|RIGHT) b.subject_type?:e(line|file)"],
    ["gh_reply_pull_comment", `POST ${RP}/pulls/{pull_number:n}/comments/{comment_id:n}/replies`, "Reply to an inline review comment.", "b.body:s"],
    ["gh_update_pull_comment", `PATCH ${RP}/pulls/comments/{comment_id:n}`, "Edit an inline review comment.", "b.body:s"],
    ["gh_delete_pull_comment", `DELETE ${RP}/pulls/comments/{comment_id:n}`, "Delete an inline review comment.", "", { destructive: true }],

    ["gh_list_requested_reviewers", `GET ${RP}/pulls/{pull_number:n}/requested_reviewers`, "Reviewers currently requested on a PR."],
    ["gh_request_reviewers", `POST ${RP}/pulls/{pull_number:n}/requested_reviewers`, "Request reviews from users and/or teams.", "b.reviewers?:sa b.team_reviewers?:sa"],
    ["gh_remove_reviewers", `DELETE ${RP}/pulls/{pull_number:n}/requested_reviewers`, "Cancel review requests.", "b.reviewers?:sa b.team_reviewers?:sa"],
  ],
};
