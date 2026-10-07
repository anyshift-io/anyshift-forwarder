# Agent instructions

## Manually validating pull requests

GitHub Actions validation workflows in this repository do not start automatically when a pull request opens or receives a commit. Run each required workflow against the pull request's latest commit before merging. A new commit requires fresh successful checks.

Slack notifications still run automatically when a GitHub reviewer is requested.

- **GitHub UI:** Open **Actions**, select the workflow, choose **Run workflow**, select the default branch, enter the pull request number, and start the run. The workflow resolves and checks out that PR's current head, including heads from forks.
- **GitHub CLI:** Agents can run the workflow from the default branch before or after merge:

  ```sh
  gh workflow run <workflow-file> --ref main --repo anyshift-io/anyshift-forwarder -f pr_number=<pull-request-number>
  ```

Replace `<workflow-file>` with the workflow path and `<pull-request-number>` with the PR number. Add `-f name=value` for each additional required workflow input. Confirm every required status has passed on the current PR head before merging.
