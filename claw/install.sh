#!/usr/bin/env bash
set -euo pipefail

OPENCLAW_PG_REPO_DEFAULT="https://github.com/woshimcs/openclaw-pg.git"
OPENCLAW_PG_DIR_DEFAULT="${HOME}/openclaw-pg"
OPENCLAW_PG_REF_DEFAULT=""
OPENCLAW_PG_MODE_DEFAULT="docker"
OPENCLAW_PG_NO_UPDATE_DEFAULT="0"
OPENCLAW_PG_NO_START_DEFAULT="0"

OPENCLAW_PG_REPO="${OPENCLAW_PG_REPO:-$OPENCLAW_PG_REPO_DEFAULT}"
OPENCLAW_PG_DIR="${OPENCLAW_PG_DIR:-$OPENCLAW_PG_DIR_DEFAULT}"
OPENCLAW_PG_REF="${OPENCLAW_PG_REF:-$OPENCLAW_PG_REF_DEFAULT}"
OPENCLAW_PG_MODE="${OPENCLAW_PG_MODE:-$OPENCLAW_PG_MODE_DEFAULT}"
OPENCLAW_PG_NO_UPDATE="${OPENCLAW_PG_NO_UPDATE:-$OPENCLAW_PG_NO_UPDATE_DEFAULT}"
OPENCLAW_PG_NO_START="${OPENCLAW_PG_NO_START:-$OPENCLAW_PG_NO_START_DEFAULT}"

print_help() {
  cat <<'EOF'
OpenClaw PG Audit installer (macOS/Linux/WSL)

Usage:
  curl -fsSL https://<your-domain>/install.sh | bash
  curl -fsSL https://<your-domain>/install.sh | bash -s -- [options]

Options:
  --dir <path>            Install directory (default: ~/openclaw-pg)
  --repo <url>            Git repo (default: https://github.com/woshimcs/openclaw-pg.git)
  --ref <git-ref>         Git ref (branch/tag/sha)
  --mode docker|native    Install mode (default: docker)
  --no-update             Skip git pull if directory exists
  --no-start              Skip running setup after cloning
  -h, --help              Show help

Environment:
  OPENCLAW_PG_DIR, OPENCLAW_PG_REPO, OPENCLAW_PG_REF
  OPENCLAW_PG_MODE, OPENCLAW_PG_NO_UPDATE, OPENCLAW_PG_NO_START
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) OPENCLAW_PG_DIR="${2:-}"; shift 2 ;;
    --repo) OPENCLAW_PG_REPO="${2:-}"; shift 2 ;;
    --ref) OPENCLAW_PG_REF="${2:-}"; shift 2 ;;
    --mode) OPENCLAW_PG_MODE="${2:-}"; shift 2 ;;
    --no-update) OPENCLAW_PG_NO_UPDATE="1"; shift ;;
    --no-start) OPENCLAW_PG_NO_START="1"; shift ;;
    -h|--help) print_help; exit 0 ;;
    *) shift ;;
  esac
done

if [[ -z "${OPENCLAW_PG_DIR}" ]]; then
  echo "Missing --dir"
  exit 2
fi

case "${OPENCLAW_PG_MODE}" in
  docker|native) ;;
  *)
    echo "Invalid --mode: ${OPENCLAW_PG_MODE} (use docker|native)"
    exit 2
    ;;
esac

is_linux() { [[ "$(uname -s 2>/dev/null || true)" == "Linux" ]] || [[ -n "${WSL_DISTRO_NAME:-}" ]]; }
is_macos() { [[ "$(uname -s 2>/dev/null || true)" == "Darwin" ]]; }

install_git_linux() {
  if command -v apt-get >/dev/null 2>&1; then
    sudo -n true >/dev/null 2>&1 || sudo -v
    sudo apt-get update -qq
    sudo apt-get install -y -qq git ca-certificates curl
    return 0
  fi
  echo "Git missing. Install git, then re-run."
  exit 1
}

install_docker_ubuntu() {
  sudo -n true >/dev/null 2>&1 || sudo -v
  sudo apt-get update -qq
  sudo apt-get install -y -qq ca-certificates curl gnupg
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --batch --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  local arch codename
  arch="$(dpkg --print-architecture)"
  codename="$(. /etc/os-release && echo "${VERSION_CODENAME}")"
  echo "deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${codename} stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
  sudo systemctl enable --now docker >/dev/null 2>&1 || true
}

ensure_git() {
  if command -v git >/dev/null 2>&1; then
    return 0
  fi
  if is_linux; then
    install_git_linux
    return 0
  fi
  if is_macos; then
    echo "Git missing. Install Xcode Command Line Tools (xcode-select --install) or Homebrew git, then re-run."
    exit 1
  fi
  echo "Unsupported OS"
  exit 1
}

ensure_docker() {
  if command -v docker >/dev/null 2>&1; then
    return 0
  fi
  if is_linux && command -v apt-get >/dev/null 2>&1 && grep -qi ubuntu /etc/os-release 2>/dev/null; then
    install_docker_ubuntu
    return 0
  fi
  echo "Docker missing. Install Docker + docker compose plugin, then re-run."
  exit 1
}

ensure_git

if [[ -d "${OPENCLAW_PG_DIR}/.git" ]]; then
  if [[ "${OPENCLAW_PG_NO_UPDATE}" != "1" ]]; then
    git -C "${OPENCLAW_PG_DIR}" pull --rebase || true
  fi
else
  mkdir -p "$(dirname "${OPENCLAW_PG_DIR}")"
  git clone --depth 1 "${OPENCLAW_PG_REPO}" "${OPENCLAW_PG_DIR}"
fi

if [[ -n "${OPENCLAW_PG_REF}" ]]; then
  git -C "${OPENCLAW_PG_DIR}" fetch --all --tags
  git -C "${OPENCLAW_PG_DIR}" checkout "${OPENCLAW_PG_REF}"
fi

if [[ "${OPENCLAW_PG_NO_START}" == "1" ]]; then
  echo "Downloaded to: ${OPENCLAW_PG_DIR}"
  exit 0
fi

if [[ "${OPENCLAW_PG_MODE}" == "docker" ]]; then
  ensure_docker
  chmod +x "${OPENCLAW_PG_DIR}/setup.sh"
  (cd "${OPENCLAW_PG_DIR}" && ./setup.sh)
  echo "Gateway URL: http://localhost:18789"
  echo "Health check: http://localhost:18789/healthz"
  exit 0
fi

echo "Native mode is not wired in this installer yet. Use docker mode, or follow repo README for native steps."
exit 2
