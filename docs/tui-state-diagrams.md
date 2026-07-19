# TUI State Diagrams

These diagrams summarize the interactive state machines declared in
`src/flows/definition.ts`. Handler-specific conditions live in
`src/flows/handlers.ts`.

Event labels use underscores in place of colons because Mermaid state diagrams
do not reliably parse colons in transition labels. Prompt cancellation is
shown as `esc`; picker handlers use the semantic event `cancelled`.

## Build command orchestration

```mermaid
stateDiagram-v2
    [*] --> buildPre
    state "buildPre flow" as buildPre
    state "trigger build + optional watch" as trigger_watch
    state "buildPost flow" as buildPost
    state "exit command" as t_exit
    state "return to caller" as t_return
    state "return to caller root" as t_return_root

    buildPre --> trigger_watch: complete
    buildPre --> t_exit: exit_command
    trigger_watch --> buildPost: build_triggered
    buildPost --> buildPre: repeat
    buildPost --> t_exit: exit_command
    buildPost --> t_return: return_to_caller
    buildPost --> t_return_root: return_to_caller_root

    t_exit --> [*]
    t_return --> [*]
    t_return_root --> [*]
```

## `listInteractive`

```mermaid
stateDiagram-v2
    [*] --> select_job
    state "select_job (root, shared picker)" as select_job
    state "action_menu" as action_menu
    state "run_action (onEnter)" as run_action
    state "exit_command (terminal)" as t_exit

    select_job --> t_exit: cancelled
    select_job --> action_menu: selected

    action_menu --> select_job: esc
    action_menu --> select_job: select_search
    action_menu --> t_exit: select_exit
    action_menu --> run_action: select_build
    action_menu --> run_action: select_rerun_last
    action_menu --> run_action: select_rerun
    action_menu --> run_action: select_view_params
    action_menu --> run_action: select_status
    action_menu --> run_action: select_history
    action_menu --> run_action: select_watch
    action_menu --> run_action: select_logs
    action_menu --> run_action: select_cancel

    run_action --> action_menu: action_ok
    run_action --> select_job: watch_cancelled
    run_action --> select_job: action_error
    run_action --> select_job: root
    run_action --> t_exit: exit

    t_exit --> [*]
```

## `buildPre`

The `entry` state delegates job selection to the shared picker. Parameter
discovery then chooses between Jenkins defaults, discovered parameter prompts,
branch selection, or custom parameters.

```mermaid
stateDiagram-v2
    [*] --> entry
    state "entry (root, shared picker)" as entry
    state "prepare_branch (onEnter)" as prepare_branch
    state "discovered_mode" as discovered_mode
    state "configure_discovered (onEnter)" as configure_discovered
    state "branch_mode" as branch_mode
    state "build_mode_back (onEnter)" as build_mode_back
    state "branch_select" as branch_select
    state "branch_remove" as branch_remove
    state "branch_remove_apply (onEnter)" as branch_remove_apply
    state "branch_entry" as branch_entry
    state "custom_confirm" as custom_confirm
    state "custom_key" as custom_key
    state "custom_value" as custom_value
    state "custom_more" as custom_more
    state "custom_more_back (onEnter)" as custom_more_back
    state "custom_cancel (onEnter)" as custom_cancel
    state "complete (terminal)" as t_complete
    state "exit_command (terminal)" as t_exit

    entry --> t_exit: cancelled
    entry --> prepare_branch: selected

    prepare_branch --> t_complete: branch_ready
    prepare_branch --> discovered_mode: parameters_mode
    prepare_branch --> configure_discovered: parameters_configure
    prepare_branch --> branch_mode: branch_mode
    prepare_branch --> branch_select: branch_select
    prepare_branch --> branch_entry: branch_entry
    prepare_branch --> custom_key: custom_key
    prepare_branch --> entry: branch_error

    discovered_mode --> build_mode_back: esc
    discovered_mode --> configure_discovered: mode_configure_discovered
    discovered_mode --> t_complete: mode_without_params
    configure_discovered --> t_complete: parameters_ready
    configure_discovered --> t_exit: parameters_cancelled

    branch_mode --> build_mode_back: esc
    branch_mode --> prepare_branch: mode_with_branch
    branch_mode --> custom_key: mode_with_custom
    branch_mode --> t_complete: mode_without_params
    build_mode_back --> entry: build_mode_entry
    build_mode_back --> t_exit: build_mode_exit

    branch_select --> branch_mode: esc
    branch_select --> custom_confirm: branch_selected
    branch_select --> branch_remove: branch_remove
    branch_select --> branch_select: branch_retry
    branch_remove --> branch_select: esc
    branch_remove --> branch_remove_apply: remove_selected
    branch_remove_apply --> branch_select: remove_done

    branch_entry --> branch_mode: esc
    branch_entry --> branch_entry: branch_retry
    branch_entry --> custom_confirm: branch_selected
    custom_confirm --> t_complete: esc
    custom_confirm --> custom_key: confirm_yes
    custom_confirm --> t_complete: confirm_no

    custom_key --> custom_cancel: esc
    custom_key --> custom_key: param_key_retry
    custom_key --> custom_value: param_key_ready
    custom_value --> custom_key: esc
    custom_value --> custom_key: param_value_retry
    custom_value --> custom_more: param_added

    custom_more --> custom_more_back: esc
    custom_more --> custom_key: select_add
    custom_more --> t_complete: select_build
    custom_more --> t_exit: select_cancel
    custom_more_back --> custom_value: custom_last_value
    custom_more_back --> custom_key: custom_key
    custom_cancel --> branch_mode: custom_mode
    custom_cancel --> custom_more: custom_review
    custom_cancel --> t_complete: custom_done

    t_complete --> [*]
    t_exit --> [*]
```

## `buildPost`

```mermaid
stateDiagram-v2
    [*] --> action_menu
    state "action_menu" as action_menu
    state "run_action (onEnter)" as run_action
    state "after_menu (onEnter)" as after_menu
    state "after_root (onEnter)" as after_root
    state "repeat_confirm (root)" as repeat_confirm
    state "repeat (terminal)" as t_repeat
    state "exit_command (terminal)" as t_exit
    state "return_to_caller (terminal)" as t_return
    state "return_to_caller_root (terminal)" as t_return_root

    action_menu --> after_menu: esc_or_done
    action_menu --> run_action: watch_logs_history_cancel_or_rerun
    run_action --> action_menu: action_ok
    run_action --> after_root: watch_cancelled_action_error_or_root
    run_action --> t_exit: exit

    after_menu --> repeat_confirm: ask_repeat
    after_menu --> t_return: return_to_caller
    after_root --> repeat_confirm: ask_repeat
    after_root --> t_return_root: return_to_caller_root
    repeat_confirm --> t_exit: esc_or_confirm_no
    repeat_confirm --> t_repeat: confirm_yes

    t_repeat --> [*]
    t_exit --> [*]
    t_return --> [*]
    t_return_root --> [*]
```

## `statusPost`

```mermaid
stateDiagram-v2
    [*] --> action_menu
    state "action_menu" as action_menu
    state "run_action (onEnter)" as run_action
    state "again_confirm (root)" as again_confirm
    state "repeat (terminal)" as t_repeat
    state "exit_command (terminal)" as t_exit

    action_menu --> again_confirm: esc_or_done
    action_menu --> run_action: build_rerun_watch_logs_history_or_cancel
    run_action --> action_menu: action_ok
    run_action --> again_confirm: watch_cancelled_action_error_or_root
    run_action --> t_exit: exit
    again_confirm --> t_exit: esc_or_confirm_no
    again_confirm --> t_repeat: confirm_yes

    t_repeat --> [*]
    t_exit --> [*]
```
