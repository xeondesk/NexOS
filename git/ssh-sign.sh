#!/usr/bin/env bash
# NexOS git SSH-signing proxy.
#
# Migrated from the v0 sandbox's v0-git-ssh-sign. A drop-in replacement for
# `ssh-keygen -Y sign` that hands the payload to a hosted signing service so
# signing keys never live on the host. Endpoint is configurable via
# NEXOS_GIT_SIGN_URL (defaults to the legacy v0 signing service); the
# namespace header keeps signatures scoped per identity.
set -euo pipefail

NEXOS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -f "$NEXOS_ROOT/config/nexos.conf" ]; then
  . "$NEXOS_ROOT/config/nexos.conf"
fi

usage() {
  echo "usage: nexos-git-ssh-sign -Y sign -n <namespace> -f <signing-key> <payload-file>" >&2
}

if [[ "${1:-}" != "-Y" ]]; then
  usage
  exit 64
fi
shift

if [[ "${1:-}" != "sign" ]]; then
  echo "unsupported ssh-keygen operation: ${1:-}" >&2
  exit 64
fi
shift

payload_file=""
namespace=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n)
      namespace="${2:-}"
      shift 2
      ;;
    -f)
      shift 2
      ;;
    -O)
      shift 2
      ;;
    --)
      shift
      ;;
    -*)
      echo "unsupported ssh-keygen sign option: $1" >&2
      exit 64
      ;;
    *)
      payload_file="$1"
      shift
      ;;
  esac
done

if [[ -z "${namespace}" || -z "${payload_file}" ]]; then
  usage
  exit 64
fi

SIGN_URL="${NEXOS_GIT_SIGN_URL:-https://git-sign.v0.app/sign}"
NAMESPACE_HEADER="${NEXOS_GIT_SIGN_NAMESPACE_HEADER:-x-v0-git-signing-namespace}"

curl \
  --fail \
  --silent \
  --show-error \
  --request POST \
  --header "content-type: application/vnd.git.ssh-signature-request" \
  --header "accept: application/vnd.git.ssh-signature" \
  --header "${NAMESPACE_HEADER}: ${namespace}" \
  --data-binary "@${payload_file}" \
  --output "${payload_file}.sig" \
  "${SIGN_URL}"
