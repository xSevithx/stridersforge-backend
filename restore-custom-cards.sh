#!/usr/bin/env bash
set -euo pipefail

# Restore custom card images into the Docker custom-cards volume.
#
# Usage:
#   ./restore-custom-cards.sh --list
#   ./restore-custom-cards.sh --restore 20260605_093000
#   ./restore-custom-cards.sh --restore ./backups/20260605_093000
#   ./restore-custom-cards.sh --restore 20260605_093000 --source-dir ./my-original-images
#
# Recovery order:
#   1. custom-cards.tar.gz from backup (new backups)
#   2. Search card-images.tar.gz / uploads.tar.gz for files listed in database.sql
#   3. Copy from --source-dir using filenames from database.sql
#   4. Copy from a stopped API container (--from-container or auto-detect)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="${SCRIPT_DIR}/backups"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"
API_CONTAINER="striderforge-api"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()   { echo -e "${GREEN}[RESTORE]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }

load_env() {
  local env_file="${SCRIPT_DIR}/.env"
  if [[ -f "$env_file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
  fi
}

volume_prefix() {
  basename "${SCRIPT_DIR}"
}

custom_cards_volume_name() {
  echo "$(volume_prefix)_custom-cards"
}

resolve_backup_path() {
  local input="$1"
  if [[ -d "$input" ]]; then
    echo "$input"
    return
  fi
  if [[ -d "${BACKUP_DIR}/${input}" ]]; then
    echo "${BACKUP_DIR}/${input}"
    return
  fi
  error "Backup not found: ${input}"
  exit 1
}

check_api_running() {
  if ! docker ps --format '{{.Names}}' | grep -q "^${API_CONTAINER}$"; then
    error "Container '${API_CONTAINER}' is not running."
    error "Start it first: docker compose -f ${COMPOSE_FILE} up -d"
    exit 1
  fi
}

ensure_custom_cards_volume() {
  local vol
  vol="$(custom_cards_volume_name)"
  if ! docker volume inspect "$vol" >/dev/null 2>&1; then
    warn "Volume '${vol}' does not exist yet. Creating via docker compose..."
    docker compose -f "${COMPOSE_FILE}" up -d api
    sleep 2
  fi
}

# Extract image_path values from custom_cards rows in database.sql
# Paths look like: custom-cards/1717601234567-abc123.jpg
extract_image_paths_from_sql() {
  local sql_file="$1"
  local out_file="$2"

  if [[ ! -f "$sql_file" ]]; then
    touch "$out_file"
    return
  fi

  # Match custom-cards/... paths anywhere in the dump (COPY rows or INSERTs)
  grep -oE 'custom-cards/[^[:space:]'\'']+\.(jpg|jpeg|png|webp|gif)' "$sql_file" \
    | sort -u > "$out_file" || true
}

copy_to_volume() {
  local source_dir="$1"
  local file_count
  file_count=$(find "$source_dir" -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.webp' -o -iname '*.gif' \) | wc -l)

  if (( file_count == 0 )); then
    return 1
  fi

  local vol
  vol="$(custom_cards_volume_name)"
  log "Copying ${file_count} file(s) into volume '${vol}' (flat into /app/data/custom-cards/)..."

  # Flatten: DB stores image_path as custom-cards/filename.jpg but files live directly in the volume root
  docker run --rm \
    -v "${vol}:/target" \
    -v "${source_dir}:/source:ro" \
    alpine sh -c '
      mkdir -p /target
      find /source -type f \( -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.png" -o -iname "*.webp" -o -iname "*.gif" \) -exec cp {} /target/ \;
      chmod -R a+r /target
    '

  log "Verifying files in container..."
  docker exec "${API_CONTAINER}" sh -c "ls -la /app/data/custom-cards/ | head -20"
  docker exec "${API_CONTAINER}" sh -c "find /app/data/custom-cards -type f | wc -l" | awk '{print "  Files in /app/data/custom-cards: " $1}'

  return 0
}

restore_from_tar() {
  local tar_file="$1"
  local dest_dir="$2"
  mkdir -p "$dest_dir"
  tar xzf "$tar_file" -C "$dest_dir"
}

search_tars_for_paths() {
  local backup_path="$1"
  local paths_file="$2"
  local dest_dir="$3"
  local found=0

  mkdir -p "$dest_dir"

  while IFS= read -r rel_path || [[ -n "$rel_path" ]]; do
    [[ -z "$rel_path" ]] && continue
    local basename_file
    basename_file="$(basename "$rel_path")"
    local extracted=false

    for archive in "${backup_path}/card-images.tar.gz" "${backup_path}/uploads.tar.gz"; do
      [[ -f "$archive" ]] || continue

      # Try full path inside tar (custom-cards/foo.jpg or ./custom-cards/foo.jpg)
      if tar tzf "$archive" 2>/dev/null | grep -qE "(^|/)${rel_path}$"; then
        tar xzf "$archive" -C "$dest_dir" "$rel_path" 2>/dev/null || \
          tar xzf "$archive" -C "$dest_dir" --wildcards "*/${rel_path}" 2>/dev/null || true
        extracted=true
      fi

      # Try basename only at any depth
      if [[ "$extracted" == false ]]; then
        local match
        match="$(tar tzf "$archive" 2>/dev/null | grep -E "/${basename_file}$" | head -1 || true)"
        if [[ -n "$match" ]]; then
          tar xzf "$archive" -C "$dest_dir" "$match" 2>/dev/null || true
          # Flatten to dest root if nested
          if [[ -f "${dest_dir}/${match}" ]]; then
            mv "${dest_dir}/${match}" "${dest_dir}/${basename_file}" 2>/dev/null || \
              cp "${dest_dir}/${match}" "${dest_dir}/${basename_file}" 2>/dev/null || true
          fi
          extracted=true
        fi
      fi

      if [[ "$extracted" == true ]]; then
        ((found++)) || true
        log "  Found: ${basename_file} (from $(basename "$archive"))"
        break
      fi
    done
  done < "$paths_file"

  echo "$found"
}

copy_from_source_dir() {
  local source_dir="$1"
  local paths_file="$2"
  local dest_dir="$3"
  local copied=0

  mkdir -p "$dest_dir"

  while IFS= read -r rel_path || [[ -n "$rel_path" ]]; do
    [[ -z "$rel_path" ]] && continue
    local basename_file
    basename_file="$(basename "$rel_path")"

    if [[ -f "${source_dir}/${rel_path}" ]]; then
      cp "${source_dir}/${rel_path}" "${dest_dir}/${basename_file}"
      ((copied++)) || true
      continue
    fi
    if [[ -f "${source_dir}/${basename_file}" ]]; then
      cp "${source_dir}/${basename_file}" "${dest_dir}/${basename_file}"
      ((copied++)) || true
    fi
  done < "$paths_file"

  echo "$copied"
}

copy_from_container() {
  local container_id="$1"
  local dest_dir="$2"

  log "Copying from container ${container_id}:/app/data/custom-cards/ ..."
  mkdir -p "$dest_dir"
  docker cp "${container_id}:/app/data/custom-cards/." "${dest_dir}/" 2>/dev/null || return 1
}

list_backups() {
  echo ""
  log "Available backups:"
  echo ""
  if [[ ! -d "$BACKUP_DIR" ]] || [[ -z "$(ls -A "$BACKUP_DIR" 2>/dev/null)" ]]; then
    warn "No backups found in ${BACKUP_DIR}"
    return
  fi
  printf "  %-20s %-12s %s\n" "TIMESTAMP" "CUSTOM TAR" "PATH"
  printf "  %-20s %-12s %s\n" "---------" "----------" "----"
  for dir in "${BACKUP_DIR}"/*/; do
    [[ -d "$dir" ]] || continue
    local name has_custom
    name="$(basename "$dir")"
    if [[ -f "${dir}/custom-cards.tar.gz" ]]; then
      has_custom="yes"
    else
      has_custom="no (legacy)"
    fi
    printf "  %-20s %-12s %s\n" "$name" "$has_custom" "$dir"
  done
  echo ""
}

do_restore() {
  local backup_input="$1"
  local source_dir="${2:-}"
  local from_container="${3:-}"

  local backup_path
  backup_path="$(resolve_backup_path "$backup_input")"

  load_env
  check_api_running
  ensure_custom_cards_volume

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT

  local staging="${tmp_dir}/staging"
  mkdir -p "$staging"

  log "Using backup: ${backup_path}"
  echo ""

  # ── Method 1: dedicated custom-cards.tar.gz ──
  if [[ -f "${backup_path}/custom-cards.tar.gz" ]]; then
    log "Found custom-cards.tar.gz — restoring directly..."
    restore_from_tar "${backup_path}/custom-cards.tar.gz" "$staging"
    if copy_to_volume "$staging"; then
      log "${CYAN}Restore complete from custom-cards.tar.gz${NC}"
      return 0
    fi
  fi

  # Build list of expected files from database
  local paths_file="${tmp_dir}/expected-paths.txt"
  extract_image_paths_from_sql "${backup_path}/database.sql" "$paths_file"
  local expected_count
  expected_count=$(wc -l < "$paths_file" | tr -d ' ')

  if (( expected_count == 0 )); then
    warn "No custom-cards/* paths found in database.sql"
    warn "The DB dump may be missing custom_cards data, or paths use a different format."
  else
    log "Database expects ${expected_count} custom card image(s)"
  fi

  # ── Method 2: search other backup tars ──
  if (( expected_count > 0 )); then
    log "Searching card-images.tar.gz and uploads.tar.gz for matching files..."
    local found_in_tars
    found_in_tars="$(search_tars_for_paths "$backup_path" "$paths_file" "$staging")"
    if (( found_in_tars > 0 )); then
      log "Recovered ${found_in_tars} file(s) from legacy backup archives"
      if copy_to_volume "$staging"; then
        if (( found_in_tars < expected_count )); then
          warn "Only ${found_in_tars}/${expected_count} files recovered from tars."
          warn "Pre-volume backups often did NOT include custom card images."
        else
          log "${CYAN}Restore complete${NC}"
          return 0
        fi
      fi
    else
      warn "No custom card files found inside card-images.tar.gz or uploads.tar.gz"
    fi
  fi

  # ── Method 3: user-provided source directory ──
  if [[ -n "$source_dir" ]]; then
    if [[ ! -d "$source_dir" ]]; then
      error "Source directory not found: ${source_dir}"
      exit 1
    fi
    log "Copying from source directory: ${source_dir}"
    rm -rf "$staging"
    mkdir -p "$staging"
    local copied
    if (( expected_count > 0 )); then
      copied="$(copy_from_source_dir "$source_dir" "$paths_file" "$staging")"
    else
      # No DB list — copy all images from source dir
      find "$source_dir" -maxdepth 1 -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.webp' \) -exec cp {} "$staging/" \;
      copied=$(find "$staging" -type f | wc -l | tr -d ' ')
    fi
    if (( copied > 0 )) && copy_to_volume "$staging"; then
      log "${CYAN}Restore complete from source directory (${copied} file(s))${NC}"
      return 0
    fi
    error "No matching images found in ${source_dir}"
    exit 1
  fi

  # ── Method 4: stopped/old API container ──
  local container_id="$from_container"
  if [[ -z "$container_id" ]]; then
    container_id="$(docker ps -a --filter "name=${API_CONTAINER}" --format "{{.ID}}" | head -1 || true)"
  fi
  if [[ -n "$container_id" ]]; then
    log "Trying stopped container ${container_id}..."
    rm -rf "$staging"
    mkdir -p "$staging"
    if copy_from_container "$container_id" "$staging" && copy_to_volume "$staging"; then
      log "${CYAN}Restore complete from container filesystem${NC}"
      return 0
    fi
  fi

  # ── Failed ──
  echo ""
  error "Could not recover custom card images from this backup."
  echo ""
  echo "Legacy backups (before custom-cards volume) usually only contain DB rows,"
  echo "not the image files — they lived on the container layer and were lost on rebuild."
  echo ""
  echo "Options:"
  echo "  1. If you still have the original image files locally:"
  echo "     ./restore-custom-cards.sh --restore ${backup_input} --source-dir /path/to/images"
  echo ""
  echo "  2. Re-upload images via Admin → Custom Cards"
  echo ""
  echo "  3. If an old API container still exists:"
  echo "     docker ps -a | grep striderforge-api"
  echo "     ./restore-custom-cards.sh --restore ${backup_input} --from-container <CONTAINER_ID>"
  echo ""
  if (( expected_count > 0 )); then
    echo "Expected filenames (from database.sql):"
    head -10 "$paths_file" | sed 's/^/  /'
    if (( expected_count > 10 )); then
      echo "  ... and $(( expected_count - 10 )) more"
    fi
  fi
  exit 1
}

usage() {
  cat <<EOF

${CYAN}StridersForge Custom Card Image Restore${NC}

Restores custom card images into the Docker volume mounted at
/app/data/custom-cards inside ${API_CONTAINER}.

Usage:
  $0 --list
  $0 --restore <backup_timestamp|path> [--source-dir DIR] [--from-container ID]

Examples:
  $0 --list
  $0 --restore 20260605_093000
  $0 --restore ./backups/20260605_093000
  $0 --restore 20260605_093000 --source-dir ~/Downloads/custom-card-images

Notes:
  - Run from the backend/ directory on your server (same place as backup.sh)
  - API container must be running: docker compose up -d
  - After restore, images are served at /images/custom-cards/<filename>.jpg

EOF
}

# ─── Main ───
BACKUP_ARG=""
SOURCE_DIR=""
FROM_CONTAINER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --restore|-r)
      BACKUP_ARG="${2:-}"
      shift 2
      ;;
    --source-dir|-s)
      SOURCE_DIR="${2:-}"
      shift 2
      ;;
    --from-container|-c)
      FROM_CONTAINER="${2:-}"
      shift 2
      ;;
    --list|-l)
      list_backups
      exit 0
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      error "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$BACKUP_ARG" ]]; then
  usage
  exit 1
fi

do_restore "$BACKUP_ARG" "$SOURCE_DIR" "$FROM_CONTAINER"
