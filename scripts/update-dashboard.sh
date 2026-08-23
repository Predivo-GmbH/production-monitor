#!/usr/bin/env bash
# update-dashboard.sh — Fetches latest commit counts and dates from GitHub API,
# updates data.json + changelog.json in the project-dashboard repo.
# Runs inside GitHub Actions (production-monitor) with GH_TOKEN.

set -euo pipefail

# Org renamed Arivioo -> Predivo-GmbH (2026-08). GitHub auto-follows the redirect
# for GET, but NOT for write (PUT/POST) requests, which 307 and fail. Use the
# canonical org name so the data.json/changelog.json PUT calls succeed.
OWNER="Predivo-GmbH"
DASHBOARD_REPO="project-dashboard"

# Fetch current data.json from the dashboard repo
echo "Fetching current data.json..."
DATA=$(gh api "repos/${OWNER}/${DASHBOARD_REPO}/contents/data.json" \
  --jq '.content' | base64 -d)
DATA_SHA=$(gh api "repos/${OWNER}/${DASHBOARD_REPO}/contents/data.json" --jq '.sha')

# Fetch current changelog.json
echo "Fetching current changelog.json..."
CHANGELOG=$(gh api "repos/${OWNER}/${DASHBOARD_REPO}/contents/changelog.json" \
  --jq '.content' | base64 -d 2>/dev/null || echo "[]")
CHANGELOG_SHA=$(gh api "repos/${OWNER}/${DASHBOARD_REPO}/contents/changelog.json" \
  --jq '.sha' 2>/dev/null || echo "")

# Extract repo names from data.json (products + tools that have a "repo" field)
REPOS=$(echo "$DATA" | jq -r '(.products + .tools) | .[] | select(.repo) | .repo')

UPDATED_DATA="$DATA"
CHANGES=0
# Build changelog changes array as JSON
CHANGELOG_CHANGES="[]"

for REPO in $REPOS; do
  echo "Checking ${REPO}..."

  # Get default branch
  BRANCH=$(echo "$DATA" | jq -r --arg r "$REPO" \
    '(.products + .tools)[] | select(.repo == $r) | .branch // "main"')

  # Get project display name
  PROJ_NAME=$(echo "$DATA" | jq -r --arg r "$REPO" \
    '(.products + .tools)[] | select(.repo == $r) | .name')

  # Get commit count via contributors API (sum all contributions)
  COMMIT_COUNT=$(gh api "repos/${OWNER}/${REPO}/contributors" \
    --jq '[.[].contributions] | add // 0' 2>/dev/null || echo "0")

  # Get last commit date
  LAST_COMMIT_DATE=$(gh api "repos/${OWNER}/${REPO}/commits?sha=${BRANCH}&per_page=1" \
    --jq '.[0].commit.committer.date' 2>/dev/null || echo "")

  if [ -z "$LAST_COMMIT_DATE" ] || [ "$COMMIT_COUNT" = "0" ]; then
    echo "  Skipping ${REPO} (no data)"
    continue
  fi

  # Format date as "D Mon" (e.g., "4 May") — handle both Z and +00:00 timezone formats
  CLEAN_DATE=$(echo "$LAST_COMMIT_DATE" | sed 's/+00:00$/Z/' | sed 's/T/ /' | sed 's/Z$//')
  FORMATTED_DATE=$(date -d "$CLEAN_DATE" '+%-d %b' 2>/dev/null || \
    date -d "$LAST_COMMIT_DATE" '+%-d %b' 2>/dev/null || echo "")

  if [ -z "$FORMATTED_DATE" ]; then
    echo "  Could not parse date for ${REPO}"
    continue
  fi

  # Get current values from data.json (newly registered repos have no .commits yet -> jq
  # emits the literal string "null", which breaks the arithmetic below under set -u)
  CURRENT_COMMITS=$(echo "$DATA" | jq -r --arg r "$REPO" \
    '(.products + .tools)[] | select(.repo == $r) | .commits')
  if [ -z "$CURRENT_COMMITS" ] || [ "$CURRENT_COMMITS" = "null" ]; then
    CURRENT_COMMITS=0
  fi

  if [ "$COMMIT_COUNT" != "$CURRENT_COMMITS" ]; then
    NEW_COMMITS=$((COMMIT_COUNT - CURRENT_COMMITS))
    echo "  ${REPO}: ${CURRENT_COMMITS} -> ${COMMIT_COUNT} commits (+${NEW_COMMITS}), last active: ${FORMATTED_DATE}"
    CHANGES=$((CHANGES + 1))

    # Fetch recent commits with full detail (up to 10 or the delta, whichever is smaller)
    FETCH_COUNT=10
    if [ "$NEW_COMMITS" -gt 0 ] && [ "$NEW_COMMITS" -lt 10 ]; then
      FETCH_COUNT=$NEW_COMMITS
    fi

    # Fetch detailed commit data: subject, body, files changed, additions, deletions
    COMMIT_DETAILS=$(gh api "repos/${OWNER}/${REPO}/commits?sha=${BRANCH}&per_page=${FETCH_COUNT}" \
      --jq '[.[] | {
        subject: (.commit.message | split("\n")[0] | if length > 100 then .[:97] + "..." else . end),
        body: (.commit.message | split("\n")[2:] | map(select(. != "" and (startswith("Co-Authored") | not))) | join(" ") | if length > 200 then .[:197] + "..." else . end),
        sha: .sha[0:7]
      }]' 2>/dev/null || echo "[]")

    # Fetch file stats for the most recent commits (additions/deletions)
    TOTAL_ADDITIONS=0
    TOTAL_DELETIONS=0
    TOTAL_FILES=0
    for SHA in $(echo "$COMMIT_DETAILS" | jq -r '.[].sha' | head -5); do
      STATS=$(gh api "repos/${OWNER}/${REPO}/commits/${SHA}" \
        --jq '{files: (.files | length), additions: .stats.additions, deletions: .stats.deletions}' \
        2>/dev/null || echo '{"files":0,"additions":0,"deletions":0}')
      TOTAL_FILES=$((TOTAL_FILES + $(echo "$STATS" | jq '.files')))
      TOTAL_ADDITIONS=$((TOTAL_ADDITIONS + $(echo "$STATS" | jq '.additions')))
      TOTAL_DELETIONS=$((TOTAL_DELETIONS + $(echo "$STATS" | jq '.deletions')))
    done

    # Build messages array (subject lines for backward compat)
    MESSAGES=$(echo "$COMMIT_DETAILS" | jq '[.[].subject]')

    # Build detailed commits array
    DETAILS=$(echo "$COMMIT_DETAILS" | jq '[.[] | {subject, body}]')

    # Add to changelog changes with rich data
    CHANGELOG_CHANGES=$(echo "$CHANGELOG_CHANGES" | jq \
      --arg name "$PROJ_NAME" \
      --arg repo "$REPO" \
      --argjson before "$CURRENT_COMMITS" \
      --argjson after "$COMMIT_COUNT" \
      --argjson delta "$NEW_COMMITS" \
      --argjson msgs "$MESSAGES" \
      --argjson details "$DETAILS" \
      --argjson files "$TOTAL_FILES" \
      --argjson additions "$TOTAL_ADDITIONS" \
      --argjson deletions "$TOTAL_DELETIONS" \
      '. + [{name: $name, repo: $repo, before: $before, after: $after, delta: $delta, messages: $msgs, details: $details, filesChanged: $files, additions: $additions, deletions: $deletions}]')
  else
    echo "  ${REPO}: ${CURRENT_COMMITS} commits (unchanged), last active: ${FORMATTED_DATE}"
  fi

  # Always update lastActive date (even if commits unchanged, date format may differ)
  UPDATED_DATA=$(echo "$UPDATED_DATA" | jq --arg r "$REPO" \
    --argjson c "$COMMIT_COUNT" --arg d "$FORMATTED_DATE" \
    '.products |= map(if .repo == $r then .commits = $c | .lastActive = $d else . end) |
     .tools |= map(if .repo == $r then .commits = $c | .lastActive = $d else . end)')
done

# Update the lastUpdated field
TODAY=$(date '+%-d %b %Y')
TODAY_ISO=$(date '+%Y-%m-%d')
UPDATED_DATA=$(echo "$UPDATED_DATA" | jq --arg d "$TODAY" '.lastUpdated = $d')

# --- Build changelog entry ---
TOTAL_NEW_COMMITS=$(echo "$CHANGELOG_CHANGES" | jq '[.[].delta] | add // 0')
PROJECTS_WORKED_ON=$(echo "$CHANGELOG_CHANGES" | jq 'length')

# Only add a changelog entry if there were actual changes
if [ "$CHANGES" -gt 0 ]; then
  echo ""
  echo "Building changelog entry: ${PROJECTS_WORKED_ON} projects, ${TOTAL_NEW_COMMITS} new commits..."

  NEW_ENTRY=$(jq -n \
    --arg date "$TODAY" \
    --arg iso "$TODAY_ISO" \
    --argjson totalNew "$TOTAL_NEW_COMMITS" \
    --argjson projCount "$PROJECTS_WORKED_ON" \
    --argjson changes "$CHANGELOG_CHANGES" \
    '{date: $date, iso: $iso, totalNewCommits: $totalNew, projectsWorkedOn: $projCount, changes: $changes}')

  # Prepend to changelog (newest first), keep last 90 days
  CHANGELOG=$(echo "$CHANGELOG" | jq --argjson entry "$NEW_ENTRY" \
    '[$entry] + . | .[0:90]')
fi

# --- Push data.json ---
echo ""
echo "Updating data.json (${CHANGES} commit changes)..."
echo "$UPDATED_DATA" | jq '.' | base64 -w 0 > /tmp/encoded-data.txt

jq -n \
  --arg message "chore: daily auto-update project stats (${TODAY})" \
  --rawfile content /tmp/encoded-data.txt \
  --arg sha "$DATA_SHA" \
  --arg branch "main" \
  '{message: $message, content: ($content | rtrimstr("\n")), sha: $sha, branch: $branch}' \
  > /tmp/data-payload.json

gh api "repos/${OWNER}/${DASHBOARD_REPO}/contents/data.json" \
  --method PUT \
  --input /tmp/data-payload.json \
  > /dev/null

rm -f /tmp/data-payload.json /tmp/encoded-data.txt
echo "data.json updated in repo."

# --- Push changelog.json ---
if [ "$CHANGES" -gt 0 ]; then
  echo "Updating changelog.json..."
  echo "$CHANGELOG" | jq '.' | base64 -w 0 > /tmp/encoded-changelog.txt

  if [ -n "$CHANGELOG_SHA" ]; then
    jq -n \
      --arg message "chore: daily changelog (${TODAY})" \
      --rawfile content /tmp/encoded-changelog.txt \
      --arg sha "$CHANGELOG_SHA" \
      --arg branch "main" \
      '{message: $message, content: ($content | rtrimstr("\n")), sha: $sha, branch: $branch}' \
      > /tmp/changelog-payload.json
  else
    jq -n \
      --arg message "chore: daily changelog (${TODAY})" \
      --rawfile content /tmp/encoded-changelog.txt \
      --arg branch "main" \
      '{message: $message, content: ($content | rtrimstr("\n")), branch: $branch}' \
      > /tmp/changelog-payload.json
  fi

  gh api "repos/${OWNER}/${DASHBOARD_REPO}/contents/changelog.json" \
    --method PUT \
    --input /tmp/changelog-payload.json \
    > /dev/null

  rm -f /tmp/changelog-payload.json /tmp/encoded-changelog.txt
  echo "changelog.json updated."
fi

# --- FTP deploy both files ---
if [ -n "${FTP_HOST:-}" ] && [ -n "${FTP_USER:-}" ] && [ -n "${FTP_PASS:-}" ]; then
  echo "Deploying to backoffice.predivo.ch via FTP..."
  echo "$UPDATED_DATA" | jq '.' > /tmp/data.json
  echo "$CHANGELOG" | jq '.' > /tmp/changelog.json
  # `curl -s` alone swallowed the outcome: a 530 printed nothing, the script carried
  # on and still said "FTP upload complete", so a stale credential would silently
  # freeze the dashboard while the workflow stayed green. Check every upload.
  # (2026-08-23)
  upload() {
    curl -sS --ssl-reqd --insecure --max-time 120 -T "$1" "ftp://${FTP_USER}:${FTP_PASS}@${FTP_HOST}/backoffice.predivo.ch/$2"
    rc=$?
    if [ "$rc" -ne 0 ]; then
      if [ "$rc" -eq 67 ]; then
        echo "::error::FTP login denied (530) uploading $2 - the FTP_PASS secret is stale."
      else
        echo "::error::FTP upload of $2 failed (curl exit $rc). The dashboard was NOT updated."
      fi
      return 1
    fi
    echo "  uploaded $2"
  }
  upload /tmp/data.json project-data.json || exit 1
  upload /tmp/changelog.json project-changelog.json || exit 1
  echo "FTP upload complete."
  rm -f /tmp/data.json /tmp/changelog.json
fi

echo "Done."
