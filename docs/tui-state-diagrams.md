# TUI State Diagrams

These diagrams visualize interactive TUI transitions and the conditions that produce each event.

Source files:

- `src/flows/definition.ts`
- `src/flows/handlers.ts`
- `src/commands/build.ts`
- `src/commands/status.ts`
- `src/commands/list.ts`

Legend:

- Edge labels use `event [condition]`.
- `esc` means the prompt returned cancel (Escape/Ctrl+C in prompt UI).
- Nodes ending in `(terminal)` are flow terminal outcomes from `runFlow()`.
- Event labels use `_` instead of `:` because Mermaid state-diagram parsing rejects `:` in transition text.

## 1) Build Command Orchestration (High-Level)

```mermaid
stateDiagram-v2
    [*] --> buildPre

    state "buildPre flow" as buildPre
    state "trigger build + optional watch" as trigger_watch
    state "buildPost flow" as buildPost

    state "exit runBuild (return {})" as exit_run
    state "return_to_caller" as ret_caller
    state "return_to_caller_root" as ret_caller_root

    buildPre --> trigger_watch: complete
    buildPre --> exit_run: exit_command

    trigger_watch --> buildPost: build triggered

    buildPost --> buildPre: repeat [reset job/url/branch]
    buildPost --> exit_run: exit_command
    buildPost --> ret_caller: return_to_caller
    buildPost --> ret_caller_root: return_to_caller_root

    exit_run --> [*]
    ret_caller --> [*]
    ret_caller_root --> [*]
```

## 2) `listInteractive` Flow

```mermaid
stateDiagram-v2
    [*] --> select_job

    state "select_job (root)" as select_job
    state "action_menu" as action_menu
    state "run_action (onEnter)" as run_action

    state "root (terminal)" as t_root
    state "exit_command (terminal)" as t_exit

    select_job --> t_root: esc
    select_job --> t_root: select_search_again (search_again or invalid selection)
    select_job --> t_exit: select_exit (value exit)
    select_job --> action_menu: select_job (matched job URL)

    action_menu --> select_job: esc
    action_menu --> t_root: select_search (Back to search)
    action_menu --> t_exit: select_exit
    action_menu --> run_action: select_build
    action_menu --> run_action: select_status
    action_menu --> run_action: select_watch
    action_menu --> run_action: select_logs
    action_menu --> run_action: select_cancel
    action_menu --> run_action: select_rerun

    run_action --> action_menu: action_ok
    run_action --> t_root: watch_cancelled
    run_action --> t_root: action_error
    run_action --> t_root: root
    run_action --> t_exit: exit

    t_root --> [*]
    t_exit --> [*]
```

## 3) `buildPre` Flow

```mermaid
stateDiagram-v2
    [*] --> entry

    state "entry (onEnter)" as entry
    state "recent_menu (root)" as recent_menu
    state "search_from_recent" as search_from_recent
    state "search_direct (root)" as search_direct
    state "results_from_recent" as results_from_recent
    state "results_direct" as results_direct
    state "prepare_branch (onEnter)" as prepare_branch
    state "branch_select" as branch_select
    state "branch_remove" as branch_remove
    state "branch_remove_apply (onEnter)" as branch_remove_apply
    state "branch_entry" as branch_entry

    state "complete (terminal)" as t_complete
    state "exit_command (terminal)" as t_exit

    entry --> recent_menu: show_recent (recent jobs exist)
    entry --> search_direct: search_direct (no recent jobs)

    recent_menu --> t_exit: esc
    recent_menu --> search_from_recent: select_search_all
    recent_menu --> prepare_branch: select_recent (recent job chosen)

    search_from_recent --> recent_menu: esc
    search_from_recent --> search_from_recent: search_retry (empty or invalid query)
    search_from_recent --> results_from_recent: search_candidates (multiple matches)
    search_from_recent --> prepare_branch: search_auto (single match)

    search_direct --> t_exit: esc
    search_direct --> search_direct: search_retry (empty or invalid query)
    search_direct --> results_direct: search_candidates (multiple matches)
    search_direct --> prepare_branch: search_auto (single match)

    results_from_recent --> search_from_recent: esc
    results_from_recent --> search_from_recent: select_search_again (invalid selection)
    results_from_recent --> prepare_branch: select_job

    results_direct --> search_direct: esc
    results_direct --> search_direct: select_search_again (invalid selection)
    results_direct --> prepare_branch: select_job

    prepare_branch --> t_complete: branch_ready (defaultBranch or branch already set)
    prepare_branch --> branch_select: branch_select (cached branches exist)
    prepare_branch --> branch_entry: branch_entry (no cached branches)
    prepare_branch --> entry: branch_error (missing selectedJobUrl)

    branch_select --> entry: esc
    branch_select --> t_complete: branch_selected (highlighted or typed custom branch)
    branch_select --> branch_remove: branch_remove (remove action selected)

    branch_remove --> branch_select: esc
    branch_remove --> branch_remove_apply: remove_selected

    branch_remove_apply --> branch_select: remove_done

    branch_entry --> branch_select: esc
    branch_entry --> branch_entry: branch_retry (empty branch)
    branch_entry --> t_complete: branch_selected

    t_complete --> [*]
    t_exit --> [*]
```

## 4) `buildPost` Flow

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

    action_menu --> after_menu: esc
    action_menu --> after_menu: done
    action_menu --> run_action: select_watch
    action_menu --> run_action: select_logs
    action_menu --> run_action: select_cancel
    action_menu --> run_action: select_rerun

    run_action --> action_menu: action_ok
    run_action --> after_root: watch_cancelled
    run_action --> after_root: action_error
    run_action --> after_root: root
    run_action --> t_exit: exit

    after_menu --> repeat_confirm: ask_repeat [returnToCaller=false]
    after_menu --> t_return: return_to_caller [returnToCaller=true]

    after_root --> repeat_confirm: ask_repeat [returnToCaller=false]
    after_root --> t_return_root: return_to_caller_root [returnToCaller=true]

    repeat_confirm --> t_exit: esc
    repeat_confirm --> t_repeat: confirm_yes
    repeat_confirm --> t_exit: confirm_no

    t_repeat --> [*]
    t_exit --> [*]
    t_return --> [*]
    t_return_root --> [*]
```

## 5) `statusPost` Flow

```mermaid
stateDiagram-v2
    [*] --> action_menu

    state "action_menu" as action_menu
    state "run_action (onEnter)" as run_action
    state "again_confirm (root)" as again_confirm

    state "repeat (terminal)" as t_repeat
    state "exit_command (terminal)" as t_exit

    action_menu --> again_confirm: esc
    action_menu --> again_confirm: done
    action_menu --> run_action: select_watch
    action_menu --> run_action: select_logs
    action_menu --> run_action: select_cancel
    action_menu --> run_action: select_rerun
    action_menu --> run_action: select_build

    run_action --> action_menu: action_ok
    run_action --> again_confirm: watch_cancelled
    run_action --> again_confirm: action_error
    run_action --> again_confirm: root
    run_action --> t_exit: exit

    again_confirm --> t_exit: esc
    again_confirm --> t_repeat: confirm_yes
    again_confirm --> t_exit: confirm_no

    t_repeat --> [*]
    t_exit --> [*]
```
