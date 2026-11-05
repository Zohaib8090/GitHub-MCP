// Issues, comments, labels, milestones, sub-issues, reactions.
const RP = "/repos/{owner}/{repo}";
const ISSUE_PICK = ["number", "title", "state", "state_reason", "user.login", "labels", "assignees", "milestone.title", "comments", "created_at", "updated_at", "html_url", "pull_request.url"];
const COMMENT_PICK = ["id", "user.login", "body", "created_at", "updated_at", "html_url"];
const REACTION = "e(+1|-1|laugh|confused|heart|hooray|rocket|eyes)";
const LIST_FILTERS = "q.state?:e(open|closed|all) q.labels?:s q.sort?:e(created|updated|comments) q.direction?:e(asc|desc) q.since?:s";

export default {
  issues: [
    ["gh_list_issues", `GET ${RP}/issues`, "List issues in a repo (pull requests also appear here; they have pull_request set).", `${LIST_FILTERS} q.assignee?:s q.creator?:s q.mentioned?:s q.milestone?:s q.type?:s`, { pick: ISSUE_PICK }],
    ["gh_list_my_issues", "GET /issues", "Issues assigned to / created by / mentioning you across all repos.", `q.filter?:e(assigned|created|mentioned|subscribed|repos|all) ${LIST_FILTERS}`, { pick: [...ISSUE_PICK, "repository.full_name"] }],
    ["gh_list_org_issues", "GET /orgs/{org}/issues", "Issues across an organization.", `q.filter?:e(assigned|created|mentioned|subscribed|all) ${LIST_FILTERS}`, { pick: [...ISSUE_PICK, "repository.full_name"] }],
    ["gh_get_issue", `GET ${RP}/issues/{issue_number:n}`, "Get one issue (also works for PRs)."],
    ["gh_create_issue", `POST ${RP}/issues`, "Create an issue.", "b.title:s b.body?:s b.assignees?:sa b.labels?:sa b.milestone?:n b.type?:s"],
    ["gh_update_issue", `PATCH ${RP}/issues/{issue_number:n}`, "Edit an issue: title, body, state (open/closed), state_reason, assignees, labels, milestone (null clears), type.", "b.title?:s b.body?:s b.state?:e(open|closed) b.state_reason?:e(completed|not_planned|reopened|duplicate) b.assignees?:sa b.labels?:sa b.milestone?:j b.type?:j"],
    ["gh_lock_issue", `PUT ${RP}/issues/{issue_number:n}/lock`, "Lock an issue or PR conversation.", "b.lock_reason?:s"],
    ["gh_unlock_issue", `DELETE ${RP}/issues/{issue_number:n}/lock`, "Unlock an issue or PR conversation."],
    ["gh_list_issue_comments", `GET ${RP}/issues/{issue_number:n}/comments`, "Comments on an issue or PR conversation.", "q.since?:s", { pick: COMMENT_PICK }],
    ["gh_add_issue_comment", `POST ${RP}/issues/{issue_number:n}/comments`, "Comment on an issue or PR (PR conversation comments use this).", "b.body:s"],
    ["gh_get_issue_comment", `GET ${RP}/issues/comments/{comment_id:n}`, "Get one issue comment."],
    ["gh_update_issue_comment", `PATCH ${RP}/issues/comments/{comment_id:n}`, "Edit an issue comment.", "b.body:s"],
    ["gh_delete_issue_comment", `DELETE ${RP}/issues/comments/{comment_id:n}`, "Delete an issue comment.", "", { destructive: true }],
    ["gh_list_repo_issue_comments", `GET ${RP}/issues/comments`, "All issue comments in the repo.", "q.sort?:e(created|updated) q.direction?:e(asc|desc) q.since?:s", { pick: COMMENT_PICK }],
    ["gh_list_issue_events", `GET ${RP}/issues/{issue_number:n}/events`, "Events on an issue (labeled, closed, ...).", "", { pick: ["id", "event", "actor.login", "created_at", "label.name", "assignee.login"] }],
    ["gh_list_issue_timeline", `GET ${RP}/issues/{issue_number:n}/timeline`, "Full timeline of an issue or PR."],

    ["gh_list_labels", `GET ${RP}/labels`, "List repo labels.", "", { pick: ["name", "color", "description"] }],
    ["gh_get_label", `GET ${RP}/labels/{label_name}`, "Get a label."],
    ["gh_create_label", `POST ${RP}/labels`, "Create a label (color is hex without #).", "b.name:s b.color?:s b.description?:s"],
    ["gh_update_label", `PATCH ${RP}/labels/{label_name}`, "Edit a label.", "b.new_name?:s b.color?:s b.description?:s"],
    ["gh_delete_label", `DELETE ${RP}/labels/{label_name}`, "Delete a label.", "", { destructive: true }],
    ["gh_add_issue_labels", `POST ${RP}/issues/{issue_number:n}/labels`, "Add labels to an issue/PR.", "b.labels:sa"],
    ["gh_set_issue_labels", `PUT ${RP}/issues/{issue_number:n}/labels`, "Replace all labels on an issue/PR.", "b.labels:sa"],
    ["gh_remove_issue_label", `DELETE ${RP}/issues/{issue_number:n}/labels/{label_name}`, "Remove one label from an issue/PR."],
    ["gh_clear_issue_labels", `DELETE ${RP}/issues/{issue_number:n}/labels`, "Remove all labels from an issue/PR.", "", { destructive: true }],

    ["gh_list_assignees", `GET ${RP}/assignees`, "Users who can be assigned.", "", { pick: ["login"] }],
    ["gh_add_assignees", `POST ${RP}/issues/{issue_number:n}/assignees`, "Assign users to an issue/PR.", "b.assignees:sa"],
    ["gh_remove_assignees", `DELETE ${RP}/issues/{issue_number:n}/assignees`, "Unassign users from an issue/PR.", "b.assignees:sa"],

    ["gh_list_milestones", `GET ${RP}/milestones`, "List milestones.", "q.state?:e(open|closed|all) q.sort?:e(due_on|completeness) q.direction?:e(asc|desc)", { pick: ["number", "title", "state", "description", "due_on", "open_issues", "closed_issues"] }],
    ["gh_get_milestone", `GET ${RP}/milestones/{milestone_number:n}`, "Get a milestone."],
    ["gh_create_milestone", `POST ${RP}/milestones`, "Create a milestone.", "b.title:s b.state?:e(open|closed) b.description?:s b.due_on?:s"],
    ["gh_update_milestone", `PATCH ${RP}/milestones/{milestone_number:n}`, "Edit a milestone.", "b.title?:s b.state?:e(open|closed) b.description?:s b.due_on?:s"],
    ["gh_delete_milestone", `DELETE ${RP}/milestones/{milestone_number:n}`, "Delete a milestone.", "", { destructive: true }],

    ["gh_list_sub_issues", `GET ${RP}/issues/{issue_number:n}/sub_issues`, "Sub-issues of an issue.", "", { pick: ISSUE_PICK.concat("id") }],
    ["gh_get_parent_issue", `GET ${RP}/issues/{issue_number:n}/parent`, "Parent of a sub-issue."],
    ["gh_add_sub_issue", `POST ${RP}/issues/{issue_number:n}/sub_issues`, "Attach a sub-issue (sub_issue_id is the issue's numeric id, not its number).", "b.sub_issue_id:n b.replace_parent?:b"],
    ["gh_remove_sub_issue", `DELETE ${RP}/issues/{issue_number:n}/sub_issue`, "Detach a sub-issue.", "b.sub_issue_id:n"],
    ["gh_reprioritize_sub_issue", `PATCH ${RP}/issues/{issue_number:n}/sub_issues/priority`, "Reorder sub-issues.", "b.sub_issue_id:n b.after_id?:n b.before_id?:n"],
    ["gh_list_issue_types", "GET /orgs/{org}/issue-types", "Issue types defined by an organization."],

    ["gh_list_issue_reactions", `GET ${RP}/issues/{issue_number:n}/reactions`, "Reactions on an issue/PR.", "q.content?:s", { pick: ["id", "content", "user.login"] }],
    ["gh_add_issue_reaction", `POST ${RP}/issues/{issue_number:n}/reactions`, "React to an issue/PR.", `b.content:${REACTION}`],
    ["gh_delete_issue_reaction", `DELETE ${RP}/issues/{issue_number:n}/reactions/{reaction_id:n}`, "Remove a reaction from an issue/PR."],
    ["gh_add_comment_reaction", `POST ${RP}/issues/comments/{comment_id:n}/reactions`, "React to an issue comment.", `b.content:${REACTION}`],
    ["gh_add_review_comment_reaction", `POST ${RP}/pulls/comments/{comment_id:n}/reactions`, "React to a PR review comment.", `b.content:${REACTION}`],
  ],
};
