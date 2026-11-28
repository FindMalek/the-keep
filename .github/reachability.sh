#!/usr/bin/env bash
# Run by workflows/reachability.yml on a GitHub runner, so it sees the sites exactly like a visitor
# on someone else's network. Pushes to ntfy.sh only when the result changes from the last run.
set -u
HOME_HOST=home.findmalek.engineer
box_ip=$(dig +short "$HOME_HOST" @1.1.1.1 | tail -1)
down=()
report="| host | result |\n|---|---|\n"
while read -r host; do
  [[ -z "$host" || "$host" == \#* ]] && continue
  ip=$(dig +short "$host" @1.1.1.1 | tail -1)
  if [[ -z "$ip" ]]; then result="no public dns"
  elif [[ -n "$box_ip" && "$ip" != "$box_ip" ]]; then result="dns points to $ip, not the box"
  else
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 --retry 2 --retry-all-errors "https://$host/")
    if [[ "$code" =~ ^[1-4][0-9][0-9]$ ]]; then result=ok; else result="http $code"; fi
  fi
  [[ "$result" == ok ]] || down+=("$host: $result")
  report+="| $host | $result |\n"
done < "$(dirname "$0")/reachability-hosts.txt"
[[ -n "$box_ip" ]] || down+=("$HOME_HOST: no public dns")

printf "box %s\n\n$report" "${box_ip:-unresolved}" >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"
previous=$(gh run list --workflow reachability.yml --status completed --limit 1 --json conclusion -q '.[0].conclusion' 2>/dev/null)
notify() { [[ -n "${NTFY_TOPIC:-}" ]] && curl -s -o /dev/null -H "title: the-keep from outside" -d "$1" "https://ntfy.sh/$NTFY_TOPIC"; }
if ((${#down[@]})); then
  printf '%s\n' "${down[@]}"
  [[ "$previous" == failure ]] || notify "$(printf 'unreachable from outside:\n'; printf '%s\n' "${down[@]}")"
  exit 1
fi
[[ "$previous" == failure ]] && notify "everything is reachable from outside again"
echo "all reachable"
