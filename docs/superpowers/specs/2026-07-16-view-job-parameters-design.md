# View Job Parameters Design

## Scope

Add a `View parameters` option after both rerun actions in the main selected-job action menu used by the root `jenkins-cli` launcher. Do not add the option to post-build or status menus.

## Design

Selecting `View parameters` routes through the existing `run_action` flow state. The list action handler calls the exported `runParams` function with the selected job URL and `nonInteractive: true`; it does not execute a child CLI process. This reuses the existing Jenkins retrieval, normalization, human rendering, no-parameter message, error handling, and secret omission.

On success, the action returns `action_ok` and the flow returns to the same selected-job action menu. Errors retain the launcher's existing `action_error` transition to job selection. No new flow state is required.

## Testing

Add focused tests proving that the option appears after both rerun actions, routes the selected job URL to `runParams`, and returns to the selected-job menu after successful rendering.
