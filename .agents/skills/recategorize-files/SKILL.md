---
name: recategorize-files
description: >
  Walk the entire project directory and verify that every file is properly categorized
  according to file-categories.json. Report uncategorized files and propose updates.
---

# Recategorize Files

This skill reviews the file categorization system to ensure every file in the project
is properly assigned to one of the five categories defined in `file-categories.json`.

## When to Use

Run this skill when:
- New files or directories have been added to the project
- You suspect the categorization registry is out of date
- Before an archive/restore operation to ensure nothing is missing

## Steps

1. **Read the categorization registry**:
   ```bash
   cat file-categories.json
   ```

2. **Run the file manager list command** and check for errors:
   ```bash
   bash scripts/file-manager.sh list
   ```
   If the output contains "UNCATEGORIZED", those files need to be assigned a category.

3. **Cross-reference with git**:
   ```bash
   # Files tracked by git
   git ls-files | wc -l

   # Untracked files (excluding gitignored)
   git ls-files --others --exclude-standard

   # Files that are gitignored but present
   git ls-files --others --ignored --exclude-standard --directory
   ```

4. **For each uncategorized file**, determine the correct category:

   | Category | Criteria |
   |----------|----------|
   | 1 — Ephemeral | Generated every build; can be deleted and rebuilt by `build.sh` |
   | 2 — Rebuildable offline | Can be rebuilt without Internet; too expensive to rebuild every build |
   | 3 — Git-tracked | Committed to the repository (or will be committed) |
   | 4 — Reference | iOS/Android reference repos; not build sources |
   | 5 — Internet-downloaded | Must be downloaded from the Internet |

5. **Propose updates** to `file-categories.json`:
   - Add new entries to the appropriate `rules` section
   - Use directory patterns (`path/`) for entire directory trees
   - Use glob patterns (`path/*.ext`) for file-type matches
   - Use exact paths for individual files

6. **Create a report artifact** summarizing:
   - Total files per category
   - Any newly categorized files and their assigned categories
   - Any files that seem miscategorized (e.g., a gitignored file showing as category 3)

## Category Definitions

- **Category 1 (Ephemeral)**: Intermediate build output regenerated every build. Examples: `dist/`, `src/faces/generated/`, unzipped geonames `.txt` files.
- **Category 2 (Rebuildable offline)**: Can be rebuilt without Internet but too costly for every build. Example: `src/__tests__/snapshots/`.
- **Category 3 (Git-tracked)**: Committed to the GitHub repository. This is the default for any file tracked by `git ls-files`.
- **Category 4 (Reference)**: iOS/Android reference repos used by developers/agents. Not build sources. The `.XXX-ref/` directories.
- **Category 5 (Internet-downloaded)**: Must be downloaded from the Internet. Examples: `node_modules/`, geonames `.zip` files, geonames admin code files.

## Key Rules

- Every file in the project directory (excluding `.git/` and `.DS_Store`) must belong to exactly one category.
- Rules in `file-categories.json` are evaluated in order; first match wins.
- Files not matched by any explicit rule but tracked by `git ls-files` default to category 3.
- `dist/` is category 3 (git-tracked) but flagged as "git-tracked build output" in listings.
