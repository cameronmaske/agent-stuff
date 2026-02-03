---
name: gt-split
description: Split a Graphite branch into multiple single-commit branches using `gt split`. Includes planning, TUI interaction guidance, and recovery procedures.
---

# Graphite Branch Splitting Skill

Split the current branch into multiple single-commit branches using `gt split --by-hunk`. 

**Important:** `gt split` requires interactive mode - it cannot run with `--no-interactive`.

## When to Use This Skill

Use when the user wants to:
- Split a large commit into multiple smaller, focused branches
- Extract specific files/changes into their own branch
- Reorganize changes for cleaner PR review

---

## Agent Workflow

Follow these steps in order when this skill is loaded.

### Step 1: Verify Prerequisites

```bash
# Check we're on a branch (not detached HEAD)
git branch --show-current

# Check for uncommitted changes (will block gt split)
git status --short

# Check graphite is tracking this branch
gt ls 2>&1 | grep -E "◉|◯" | head -5
```

**If uncommitted changes exist:** STOP and ask user to commit or stash first.

### Step 2: Analyze Current Branch

```bash
# Get branch info
CURRENT_BRANCH=$(git branch --show-current)
PARENT_BRANCH=$(gt parent)
echo "=== Branch Info ==="
echo "Current: $CURRENT_BRANCH"
echo "Parent: $PARENT_BRANCH"

# Child branches (will be restacked automatically)
echo -e "\n=== Child Branches ==="
gt children

# Commits to split
echo -e "\n=== Commits on Branch ==="
git log --oneline ${PARENT_BRANCH}..HEAD

# Files in HEAD commit
echo -e "\n=== Files in HEAD Commit ==="
git show --stat HEAD --format=""
```

### Step 3: Create Split Plan

Present a plan to the user in this format:

```markdown
## Split Plan for `[branch-name]`

**Current State:**
- Branch: `[name]`
- Parent: `[parent]`
- Children (will be restacked): [list or "none"]
- PR: #[number] (if known)

**Proposed Split:**

| # | Branch Name | Files | Commit Message |
|---|-------------|-------|----------------|
| 1 | `[name]` | [file list] | [message] |
| 2 | `[name]` | [file list] | [message] |

**TUI Execution Sequence:**
For each file shown in `gt split`, here's what to press:
- `[filename]` → `[d|a|y|n]` ([reason])
- ...

**Notes:**
- To keep PR #[X] linked, use original branch name `[name]` for one of the splits
```

**Ask the user to confirm or modify the plan before proceeding.**

### Step 4: Execute the Split

Once user confirms:

```bash
# 1. Stash ALL uncommitted content (REQUIRED)
git stash push -u -m "gt-split: temporary stash"

# 2. Verify clean state
git status --short
# Should show nothing
```

Then start the interactive split:

```bash
EDITOR=vim GIT_EDITOR=vim gt split --by-hunk --no-verify
```

**Note:** 
- `--no-verify` skips pre-commit hooks during split (avoids failures from missing newlines, formatting, etc.)
- `EDITOR=vim` ensures commit messages open in vim (which can be controlled via input commands)

**Guide the user through the TUI** using the execution sequence from the plan.

### IMPORTANT: Always Read Before Sending

**Before sending ANY input to the interactive shell, ALWAYS query the output first to verify the current state.** The TUI can be in different states:

1. **Hunk selection** (`[y,n,q,a,d,j,J,g,/,e,p,?]?`) - send `d`, `a`, `y`, `n`, `q`
2. **Vim editor** (shows file content with `~` lines) - send `i`, text, `<Esc>`, `:wq<Enter>`
3. **Branch name prompt** (`Enter a branch name:`) - send branch name + Enter
4. **Remaining files list** - shows files, followed by hunk selection

**Workflow for each command:**
```
1. Query output: interactive_shell({ sessionId, outputLines: 30 })
2. Identify state from output
3. Send input with explicit Enter key:
   interactive_shell({ sessionId, input: "d", inputKeys: ["enter"] })
4. Repeat
```

**Use `inputKeys: ["enter"]` instead of `\n` in input** - more reliable for TUI interaction.

**Never send multiple commands blindly** - the TUI state may not be what you expect.

### Step 5: Post-Split Cleanup

After `gt split` completes successfully:

```bash
# 1. Restore stashed files
git stash pop

# 2. Verify new branch structure
gt ls

# 3. Show result
echo "Split complete! New branches:"
git branch --list | tail -5
```

### Step 6: Fix Formatting on Each New Branch

Since we used `--no-verify`, run pre-commit on each new branch to fix formatting:

```bash
# For each new branch created:
gt checkout [branch-name]

# Get files changed in this branch's commit
FILES=$(git diff --name-only HEAD~1 HEAD)

# Run pre-commit on just those files
pre-commit run --files $FILES

# If pre-commit made changes, amend the commit
if [[ -n $(git status --porcelain) ]]; then
    git add -A
    gt modify --no-interactive
fi
```

Repeat for each branch created during the split.

**Quick version for two branches:**
```bash
# Branch 1
gt checkout [first-branch]
FILES=$(git diff --name-only HEAD~1 HEAD)
pre-commit run --files $FILES || true

# Only add the FILES that were in this commit, NOT all changes (avoid adding untracked files!)
if [[ -n $(git status --porcelain -- $FILES) ]]; then
    git add $FILES
    gt modify --no-interactive 2>/dev/null || true
fi

# Branch 2  
gt checkout [second-branch]
FILES=$(git diff --name-only HEAD~1 HEAD)
pre-commit run --files $FILES || true

if [[ -n $(git status --porcelain -- $FILES) ]]; then
    git add $FILES
    gt modify --no-interactive 2>/dev/null || true
fi
```

**WARNING:** Do NOT use `git add -A` - it will add untracked files! Only add the specific files from the commit.

---

## TUI Command Reference

The `gt split --by-hunk` TUI uses a `git add -p` style interface.

### Navigation Commands

| Key | Action | Scope | When to Use |
|-----|--------|-------|-------------|
| `y` | **Stage this hunk** | Single hunk | Include this specific change |
| `n` | **Skip this hunk** | Single hunk | Skip this change, see next hunk |
| `a` | **Stage rest of FILE** | Current file only | Stage this + all remaining hunks IN THIS FILE, then move to next file |
| `d` | **Skip rest of FILE** | Current file only | Skip this + all remaining hunks IN THIS FILE, then move to next file |
| `q` | **Quit staging** | All remaining | Done selecting - commit what's staged, leave rest for next branch |
| `j` | Next undecided hunk | Single hunk | Skip without deciding |
| `J` | Next hunk | Single hunk | Move forward |
| `g` | Go to hunk | Navigation | Jump to specific hunk number |
| `/` | Search | Navigation | Find hunk by regex |
| `e` | **Edit hunk** | Single hunk | Manually edit (advanced) |
| `p` | Print hunk | Display | Show current hunk again |
| `?` | Help | Display | Show all commands |

**CRITICAL:** `a` and `d` only affect the CURRENT FILE, not all remaining files!
- To stage ALL remaining files: send `a` once PER FILE
- To skip ALL remaining files: send `d` once PER FILE

### Common Patterns

**To isolate specific files into Branch 1:**
```
(file you DON'T want) → d    # skip entire file
(file you DON'T want) → d    # skip entire file
(file you DO want)    → a    # stage entire file
(file you DON'T want) → d    # skip entire file
→ q                          # done with branch 1
→ [enter commit message]
→ [enter branch name]
# Continues with Branch 2 for remaining files
```

**To split by feature area:**
```
(feature A file) → a         # stage all
(feature B file) → d         # skip for later
(feature A file) → a         # stage all
→ q                          # done with feature A branch
→ [commit & name]
(feature B file) → a         # now stage these
→ q                          # done with feature B branch
```

### Editing Hunks (Advanced)

Press `e` to manually edit when you need finer control than file-level:

- Opens hunk in your editor (usually vim)
- Lines with `-` are deletions
- Lines with `+` are additions
- Lines with ` ` (space) are context
- **To exclude an addition:** Delete the entire `+` line
- **To exclude a deletion:** Change `-` to ` ` (space)
- Save and exit to apply

**Warning:** Invalid edits are rejected. The hunk must remain a valid diff.

---

## Recovery Procedures

### If `gt split` Fails Mid-Way

```bash
# 1. Check state
git status
git branch --show-current

# 2. If detached HEAD with changes:
git stash push -u -m "recovery stash"
git checkout [original-branch]
git stash pop
```

### To Abort Mid-Split

Press `Ctrl+C` during TUI. Output will show:
```
Exited early: no new branches created. You are still on [branch].
```

No changes are made - safe to retry.

### If You Made a Mistake

```bash
# If split just completed and you want to undo:
# 1. Go to parent
gt down

# 2. Delete wrong branches
gt branch delete [wrong-branch-1]
gt branch delete [wrong-branch-2]

# 3. Original changes recoverable via reflog
git reflog
```

### If Child Branches Are Orphaned

```bash
# Manually restack
gt upstack restack
```

---

## Example Session

User request: "Split seed_offers.py into its own branch"

**Analysis output:**
```
=== Branch Info ===
Current: add-commercial-cogs
Parent: fake-local-cogs

=== Child Branches ===
plan-small-commercial

=== Files in HEAD Commit ===
 apps/admin_cogs/services.py                        | 162 +
 apps/admin_cogs/templates/cogs/index.html          |  37 +
 apps/admin_cogs/templates/cogs/partials/...        | 413 +
 apps/admin_cogs/tests/test_e2e.py                  |  83 +
 apps/admin_cogs/tests/test_services.py             | 257 +
 apps/admin_cogs/views.py                           |  14 +
 apps/pricing/management/commands/seed_offers.py    | 149 +
 apps/pricing/tests/setup.py                        |  61 +
 apps/pricing_cogs/tests/setup.py                   |  37 +
```

**Split Plan:**

| # | Branch | Files | Message |
|---|--------|-------|---------|
| 1 | `seed-offers-commercial-tou` | `seed_offers.py` (1 file) | "Add commercial TOU to seed_offers" |
| 2 | `add-commercial-cogs` | All others (8 files) | "Re-design COGs page" (keeps PR) |

**Command count:**
- Branch 1: 6×`d` + 1×`a` + 2×`d` + `q` = skip 6 files, stage 1, skip 2, done
- Branch 2: 8×`a` + `q` = stage all 8 remaining files, done

**TUI Sequence:**
```
EDITOR=vim GIT_EDITOR=vim gt split --by-hunk --no-verify

# Branch 1: Stage only seed_offers.py
apps/admin_cogs/services.py                    → d + Enter (skip file)
apps/admin_cogs/templates/cogs/index.html      → d + Enter (skip file)
apps/admin_cogs/templates/.../cogs_values.html → d + Enter (skip file)
apps/admin_cogs/tests/test_e2e.py              → d + Enter (skip file)
apps/admin_cogs/tests/test_services.py         → d + Enter (skip file)
apps/admin_cogs/views.py                       → d + Enter (skip file)
apps/pricing/management/commands/seed_offers.py → a + Enter (STAGE THIS FILE)
apps/pricing/tests/setup.py                    → d + Enter (skip file)
apps/pricing_cogs/tests/setup.py               → d + Enter (skip file)
→ q + Enter (done staging branch 1)
→ [vim opens] → ggdGi[message]<Esc>:wq<Enter>
→ "seed-offers-commercial" + Enter

# Branch 2: Stage ALL remaining files (need 'a' for EACH file!)
apps/admin_cogs/services.py                    → a + Enter (stage file)
apps/admin_cogs/templates/cogs/index.html      → a + Enter (stage file)
apps/admin_cogs/templates/.../cogs_values.html → a + Enter (stage file)
apps/admin_cogs/tests/test_e2e.py              → a + Enter (stage file)
apps/admin_cogs/tests/test_services.py         → a + Enter (stage file)
apps/admin_cogs/views.py                       → a + Enter (stage file)
apps/pricing/tests/setup.py                    → a + Enter (stage file)
apps/pricing_cogs/tests/setup.py               → a + Enter (stage file)
→ q + Enter (done staging branch 2)
→ [vim opens] → ggdGi[message]<Esc>:wq<Enter>
→ "add-commercial-cogs" + Enter
```

**Post-split formatting fix:**
```bash
# Fix branch 1
gt checkout seed-offers-commercial
pre-commit run --files $(git diff --name-only HEAD~1 HEAD) || true
git add -A && gt modify --no-interactive 2>/dev/null || true

# Fix branch 2
gt checkout add-commercial-cogs
pre-commit run --files $(git diff --name-only HEAD~1 HEAD) || true
git add -A && gt modify --no-interactive 2>/dev/null || true
```

---

## Common Pitfalls

1. **`a` and `d` are FILE-scoped, not global**
   - `a` stages rest of CURRENT FILE only, then moves to next file
   - `d` skips rest of CURRENT FILE only, then moves to next file
   - To stage ALL remaining files, send `a` once PER FILE

2. **Use `inputKeys: ["enter"]` not `\n`**
   - More reliable for TUI interaction
   - Example: `interactive_shell({ sessionId, input: "d", inputKeys: ["enter"] })`

3. **Don't use `git add -A` in post-split cleanup**
   - It adds untracked files!
   - Only add the specific files: `git add $FILES`

4. **Query rate limiting (60s) can cause stalls**
   - Don't query between every command
   - Send command sequences quickly, query only at checkpoints

5. **Set EDITOR=vim for commit messages**
   - Allows sending vim commands: `ggdGi[message]<Esc>:wq<Enter>`
   - Without this, VS Code or other GUI editors may open

## Quick Reference

```bash
# Pre-split
git stash push -u -m "gt-split: temporary stash"
git status --short  # must be empty

# Split (--no-verify skips pre-commit, EDITOR=vim for terminal editing)
EDITOR=vim GIT_EDITOR=vim gt split --by-hunk --no-verify

# TUI commands (each needs Enter):
# d = skip rest of FILE | a = stage rest of FILE | y/n = single hunk | q = done

# Post-split
git stash pop
gt ls

# Fix formatting on each new branch (careful: only add changed files!)
for branch in [branch1] [branch2]; do
    gt checkout $branch
    FILES=$(git diff --name-only HEAD~1 HEAD)
    pre-commit run --files $FILES || true
    git add $FILES 2>/dev/null && gt modify --no-interactive 2>/dev/null || true
done
```
