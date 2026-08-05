# Source this file to make the `ccp` shell function available:
#
#   source /path/to/shell/ccp.sh
#   ccp use work
#   ccp use          # no Alias: shows an interactive picker on stderr (ticket #9)
#
# Per ADR-0004, a child process cannot modify its parent shell's environment, so Binding can
# only happen by this function `eval`-ing output the `ccp` program prints to stdout. `command
# ccp` (not bare `ccp`) reaches the real executable instead of recursing into this function.

ccp() {
  if [ "$1" = "use" ]; then
    local __ccp_output
    __ccp_output="$(command ccp "$@")"
    local __ccp_status=$?
    # Only `eval` on success: a non-zero exit means `ccp` printed nothing to bind (ADR-0004), so
    # evaluating here would either be a no-op or, worse, risk running stray output as code.
    if [ "$__ccp_status" -eq 0 ] && [ -n "$__ccp_output" ]; then
      eval "$__ccp_output"
    fi
    return "$__ccp_status"
  fi

  command ccp "$@"
}
